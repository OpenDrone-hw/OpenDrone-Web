import {redirect} from 'react-router';
import type {Route} from './+types/cart.$lines';
import {
  anyComingSoonLocks,
  comingSoonFlag,
  findLockedMerchandise,
  preordersOpenFlag,
  stampPreorderLines,
} from '~/lib/coming-soon';
import {anyPreorderProducts} from '~/lib/product-content';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';

/**
 * Automatically creates a new cart based on the URL and redirects straight to checkout.
 * Expected URL structure:
 * ```js
 * /cart/<variant_id>:<quantity>
 *
 * ```
 *
 * More than one `<variant_id>:<quantity>` separated by a comma, can be supplied in the URL, for
 * carts with more than one product variant.
 *
 * With `?view=1` the shared lines are applied and the visitor lands on /cart
 * instead of being pushed straight into Shopify checkout — this is the
 * "share this cart" link mode, where the recipient should review before
 * paying. In view mode the shared lines MERGE into the recipient's existing
 * cart (cart.addLines) when they already have lines — a shared link must
 * never silently destroy someone's in-progress cart. A fresh/empty cart
 * still goes through cart.create, as does the classic checkout deep link.
 *
 * `?discount=` accepts one code or several comma-separated codes.
 *
 * @example
 * Example path creating a cart with two product variants, different quantities, and a discount code in the querystring:
 * ```js
 * /cart/41007289663544:1,41007289696312:2?discount=HYDROBOARD
 *
 * ```
 */
export async function loader({request, context, params}: Route.LoaderArgs) {
  const {cart} = context;
  const {lines} = params;
  if (!lines) return redirect('/cart');
  let linesMap = lines.split(',').map((line) => {
    const lineDetails = line.split(':');
    const variantId = lineDetails[0];
    const quantity = parseInt(lineDetails[1], 10);

    if (!quantity || quantity <= 0 || isNaN(quantity)) {
      throw new Response('Invalid quantity in cart link', {status: 400});
    }

    return {
      merchandiseId: `gid://shopify/ProductVariant/${variantId}`,
      quantity,
    };
  });

  // Server-side coming-soon gate: cart permalinks are the documented
  // agent/deep-link order path, so locked SKUs must be dropped here too.
  // Zero-cost when the shop is unlocked and nothing is override-locked.
  const soonFlag = comingSoonFlag(context.env);
  const preordersOpen = preordersOpenFlag(context.env);
  const statusFlags = await fetchStatusFlagsFast(
    context.env.GITHUB_STATUS_TOKEN,
    undefined,
    context.waitUntil,
  );
  if (anyComingSoonLocks(soonFlag, statusFlags) || anyPreorderProducts()) {
    const {lockedIds, lockedHandles, preorderNotes} =
      await findLockedMerchandise(
        context.storefront,
        soonFlag,
        linesMap.map((l) => l.merchandiseId),
        statusFlags,
        preordersOpen,
      );
    linesMap = stampPreorderLines(linesMap, preorderNotes);
    if (lockedIds.size > 0) {
      const open = linesMap.filter((l) => !lockedIds.has(l.merchandiseId));
      if (open.length === 0) {
        // Every requested line is locked — send the visitor to the PDP,
        // where the notify-at-launch signup lives (or the catalog when the
        // lookup couldn't resolve a handle).
        return redirect(
          lockedHandles[0]
            ? `/products/${lockedHandles[0]}`
            : '/collections/all',
        );
      }
      linesMap = open;
    }
  }

  if (!linesMap.length) return redirect('/cart');

  const url = new URL(request.url);
  const searchParams = new URLSearchParams(url.search);

  const discount = searchParams.get('discount');
  const discountArray = discount
    ? discount.split(',').filter(Boolean)
    : [];
  const viewMode = searchParams.get('view') === '1';

  if (viewMode) {
    // Shared-cart view mode with an existing non-empty cart: MERGE the
    // shared lines into it instead of replacing it. cart.create would
    // silently wipe whatever the recipient already had in progress.
    const existing = await cart.get();
    const existingLines = existing?.lines?.nodes ?? [];
    if (existing && existingLines.length) {
      // Idempotent-ish merge: a shared link re-clicked (refresh, back button,
      // second tap) must not keep stacking quantities. Semantics: the link
      // expresses "have at least <qty> of <variant>" — for each shared line
      // we only add the DELTA up to the shared quantity. A recipient who
      // already holds that variant at >= the shared quantity gets nothing
      // added; one holding less is topped up to it. Quantities the recipient
      // raised beyond the shared amount themselves are left untouched.
      const haveByVariant = new Map<string, number>();
      for (const line of existingLines) {
        const mid = line.merchandise?.id;
        if (!mid) continue;
        haveByVariant.set(mid, (haveByVariant.get(mid) ?? 0) + line.quantity);
      }
      const deltaLines = linesMap
        .map((l) => ({
          ...l,
          quantity: l.quantity - (haveByVariant.get(l.merchandiseId) ?? 0),
        }))
        .filter((l) => l.quantity > 0);

      let cartId = existing.id;
      if (deltaLines.length) {
        const result = await cart.addLines(deltaLines);
        if (result.errors?.length || !result.cart) {
          throw new Response('Link may be expired. Try checking the URL.', {
            status: 410,
          });
        }
        cartId = result.cart.id;
      }
      if (discountArray.length) {
        // updateDiscountCodes replaces the whole set — keep whatever codes
        // the recipient already applied and add the shared ones on top.
        const existingCodes = (existing.discountCodes ?? []).map(
          (c) => c.code,
        );
        const discountResult = await cart.updateDiscountCodes([
          ...new Set([...existingCodes, ...discountArray]),
        ]);
        const discountUserErrors = discountResult?.userErrors ?? [];
        if (discountUserErrors.length) {
          // Non-fatal (an invalid shared code shouldn't kill the merge), but
          // don't swallow it silently either.
          console.warn(
            '[cart.$lines] updateDiscountCodes userErrors:',
            discountUserErrors
              .map((e) => `${e.code ?? 'UNKNOWN'}: ${e.message}`)
              .join('; '),
          );
        }
      }
      const headers = cart.setCartId(cartId);
      return redirect('/cart', {headers});
    }
  }

  // create a cart
  const result = await cart.create({
    lines: linesMap,
    discountCodes: discountArray,
  });

  const cartResult = result.cart;

  if (result.errors?.length || !cartResult) {
    throw new Response('Link may be expired. Try checking the URL.', {
      status: 410,
    });
  }

  // Update cart id in cookie
  const headers = cart.setCartId(cartResult.id);

  // Shared-cart view mode: land on the cart page for review, not checkout.
  if (viewMode) {
    return redirect('/cart', {headers});
  }

  // redirect to checkout
  if (cartResult.checkoutUrl) {
    return redirect(cartResult.checkoutUrl, {headers});
  } else {
    throw new Error('No checkout URL found');
  }
}

export default function Component() {
  return null;
}
