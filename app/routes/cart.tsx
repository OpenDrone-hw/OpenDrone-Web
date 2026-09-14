import {useLoaderData, data, type HeadersFunction} from 'react-router';
import type {Route} from './+types/cart';
import type {CartQueryDataReturn} from '@shopify/hydrogen';
import {CartForm} from '@shopify/hydrogen';
import {CartMain} from '~/components/CartMain';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {
  anyComingSoonLocks,
  comingSoonFlag,
  findLockedMerchandise,
  preordersOpenFlag,
  stampPreorderLines,
} from '~/lib/coming-soon';
import {anyPreorderProducts} from '~/lib/product-content';
import {VOTE_ATTR_KEY, parseVoteRank, serializeVoteRank} from '~/lib/votes';
import {fetchStatusFlagsFast, votableIds} from '~/lib/roadmap-data';

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('cart.meta_title') ?? 'Cart',
    description:
      copyText('cart.meta_description') ??
      'Review the items currently in your OpenDrone cart.',
    robots: 'noindex,nofollow',
  });

export const headers: HeadersFunction = ({actionHeaders}) => actionHeaders;

// The only cart attributes a client may set — the first-touch attribution
// promoted from sessionStorage (see app/lib/growth/attribution.ts). Cart
// attributes flow into Shopify order custom attributes, which the
// orders/paid webhook joins back to a channel, so this must stay a
// tight allowlist: without it a malicious POST could stuff arbitrary
// keys/values into order records. The `_` prefix keeps the attributes
// hidden from the customer at checkout (Shopify convention).
const ATTRIBUTE_KEY_ALLOWLIST = new Set([
  '_utm_source',
  '_utm_medium',
  '_utm_campaign',
  '_landing',
  VOTE_ATTR_KEY,
]);
const ATTRIBUTE_VALUE_MAX = 64;

export async function action({request, context}: Route.ActionArgs) {
  const {cart} = context;

  const formData = await request.formData();

  const {action, inputs} = CartForm.getFormInput(formData);

  if (!action) {
    throw new Error('No action provided');
  }

  let status = 200;
  let result: CartQueryDataReturn;
  // Set when the coming-soon gate drops some (but not all) requested lines,
  // so the cart drawer can tell the visitor what didn't make it in.
  let comingSoonNotice: string | null = null;

  switch (action) {
    case CartForm.ACTIONS.LinesAdd: {
      // Server-side coming-soon gate: the client hides add-to-cart for
      // locked products, but a direct POST could still push one into the
      // cart. Zero-cost when the shop is unlocked and nothing is
      // override-locked — no extra query.
      let lines = inputs.lines ?? [];
      const soonFlag = comingSoonFlag(context.env);
      const preordersOpen = preordersOpenFlag(context.env);
      const statusFlags = await fetchStatusFlagsFast(
        context.env.GITHUB_STATUS_TOKEN,
        undefined,
        context.waitUntil,
      );
      // The same lookup also finds pre-order lines, which get the
      // "Pre-order" attribute stamped server-side (see stampPreorderLines).
      if (
        lines.length > 0 &&
        (anyComingSoonLocks(soonFlag, statusFlags) || anyPreorderProducts())
      ) {
        const {lockedIds, preorderNotes} = await findLockedMerchandise(
          context.storefront,
          soonFlag,
          lines
            .map((l) => l.merchandiseId)
            .filter((id): id is string => Boolean(id)),
          statusFlags,
          preordersOpen,
        );
        lines = stampPreorderLines(lines, preorderNotes);
        if (lockedIds.size > 0) {
          const open = lines.filter(
            (l) => !l.merchandiseId || !lockedIds.has(l.merchandiseId),
          );
          if (open.length === 0) {
            return data(
              {
                cart: null,
                errors: [
                  {
                    message:
                      copyText('cart.error_coming_soon_all') ??
                      'This product is coming soon and not orderable yet. Join the launch list on the product page instead.',
                  },
                ],
                warnings: [],
                analytics: {cartId: null},
              },
              {status: 409},
            );
          }
          comingSoonNotice =
            copyText('cart.warning_coming_soon_some') ??
            'Some items are coming soon and were not added to the cart.';
          lines = open;
        }
      }
      result = await cart.addLines(lines);
      break;
    }
    case CartForm.ACTIONS.LinesUpdate:
      result = await cart.updateLines(inputs.lines);
      break;
    case CartForm.ACTIONS.LinesRemove:
      result = await cart.removeLines(inputs.lineIds);
      break;
    case CartForm.ACTIONS.DiscountCodesUpdate: {
      const formDiscountCode = inputs.discountCode;

      // User inputted discount code
      const discountCodes = (
        formDiscountCode ? [formDiscountCode] : []
      ) as string[];

      // Combine discount codes already applied on cart
      discountCodes.push(...inputs.discountCodes);

      result = await cart.updateDiscountCodes(discountCodes);
      break;
    }
    case CartForm.ACTIONS.GiftCardCodesAdd: {
      const formGiftCardCode = inputs.giftCardCode;

      const giftCardCodes = (
        formGiftCardCode ? [formGiftCardCode] : []
      ) as string[];

      result = await cart.addGiftCardCodes(giftCardCodes);
      break;
    }
    case CartForm.ACTIONS.GiftCardCodesRemove: {
      const appliedGiftCardIds = inputs.giftCardCodes as string[];
      result = await cart.removeGiftCardCodes(appliedGiftCardIds);
      break;
    }
    case CartForm.ACTIONS.BuyerIdentityUpdate: {
      // Allowlist the fields a client may set and force the cart's
      // market to Belgium regardless of what the client sends. Without
      // this a malicious POST could switch countryCode to a sanctioned
      // region between server render and checkout, or inject an
      // arbitrary email/phone into analytics and abandoned-cart flows.
      const buyer = inputs.buyerIdentity ?? {};
      result = await cart.updateBuyerIdentity({
        countryCode: 'BE',
        email: buyer.email,
        phone: buyer.phone,
      });
      break;
    }
    case CartForm.ACTIONS.AttributesUpdateInput: {
      // Allowlist + clamp, mirroring the BuyerIdentityUpdate hardening
      // above: only the attribution keys, values trimmed and capped.
      const requested: unknown[] = Array.isArray(inputs.attributes)
        ? inputs.attributes
        : [];
      const attributes = requested
        .map((a) => a as {key?: unknown; value?: unknown} | null)
        .filter(
          (a): a is {key: string; value: string} =>
            Boolean(a) &&
            typeof a?.key === 'string' &&
            typeof a?.value === 'string',
        )
        .filter((a) => ATTRIBUTE_KEY_ALLOWLIST.has(a.key))
        .map((a) => ({
          key: a.key,
          value: a.value.trim().slice(0, ATTRIBUTE_VALUE_MAX),
        }))
        // The vote is re-encoded through the codec, not just length-capped:
        // only known roadmap ids in a known format reach the order records
        // the tally script will trust. Validated against ALL roadmap ids,
        // not just today's candidates, so a ballot cast minutes before its
        // project graduates still counts. An empty re-encode (all ids bogus)
        // falls through to the length filter below, clearing the vote.
        .map((a) =>
          a.key === VOTE_ATTR_KEY
            ? {
                key: a.key,
                value: serializeVoteRank(parseVoteRank(a.value, votableIds())),
              }
            : a,
        )
        .filter((a) => a.value.length > 0);
      result = await cart.updateAttributes(attributes);
      break;
    }
    default:
      throw new Error(`${action} cart action is not defined`);
  }

  const cartId = result?.cart?.id;
  const headers = cartId ? cart.setCartId(result.cart.id) : new Headers();
  const {cart: cartResult, errors, warnings} = result;

  const redirectTo = formData.get('redirectTo') ?? null;
  if (typeof redirectTo === 'string') {
    // Only allow relative paths to prevent open redirect
    if (redirectTo.startsWith('/') && !redirectTo.startsWith('//')) {
      status = 303;
      headers.set('Location', redirectTo);
    }
  }

  return data(
    {
      cart: cartResult,
      errors,
      warnings: comingSoonNotice
        ? [...(warnings ?? []), {message: comingSoonNotice}]
        : warnings,
      analytics: {
        cartId,
      },
    },
    {status, headers},
  );
}

export async function loader({context}: Route.LoaderArgs) {
  const {cart} = context;
  return {cart: await cart.get()};
}

export default function Cart() {
  const {cart} = useLoaderData<typeof loader>();

  return (
    <div className="cart page-shell">
      <header className="page-header">
        <Txt id="cart.eyebrow" as="p" className="page-eyebrow" />
        <Txt id="cart.title" as="h1" className="page-title" />
        <Txt id="cart.description" as="p" className="page-description" />
      </header>
      <CartMain layout="page" cart={cart} />
    </div>
  );
}
