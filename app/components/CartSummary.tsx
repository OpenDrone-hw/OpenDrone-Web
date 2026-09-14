import type {CartApiQueryFragment} from 'storefrontapi.generated';
import type {CartLayout} from '~/components/CartMain';
import {Money, type OptimisticCart} from '@shopify/hydrogen';
import {useEffect, useId, useRef, useState} from 'react';
import {Link} from 'react-router';
import {useAside} from '~/components/Aside';
import {CartGoalMeter} from '~/components/CartGoalMeter';
import {preorderNoteOf} from '~/components/CartLineItem';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';

type CartSummaryProps = {
  cart: OptimisticCart<CartApiQueryFragment | null>;
  layout: CartLayout;
};

// Discount + gift card entry is handled by Shopify's checkout page, so
// the cart summary only shows totals and sends the user onward. Keeps
// the aside compact and lets lines breathe.
export function CartSummary({cart, layout}: CartSummaryProps) {
  const className =
    layout === 'page' ? 'cart-summary-page' : 'cart-summary-aside';
  const summaryId = useId();
  const {close} = useAside();

  // VAT figure for the page register. Shopify reports totalTaxAmount once
  // it has resolved taxes for the cart; until then derive the included
  // Belgian VAT (21%) from the VAT-inclusive total — the market is forced
  // to BE by the cart action, so the rate is fixed, and the note below
  // already promises "prices include VAT".
  // NB: Shopify returns "0.0" (truthy string) while taxes are unresolved —
  // compare numerically or the register would show "VAT included — €0.00".
  const cost = cart?.cost;
  const reportedTax =
    cost?.totalTaxAmount && parseFloat(cost.totalTaxAmount.amount ?? '0') > 0
      ? cost.totalTaxAmount
      : null;
  const vatAmount =
    reportedTax ??
    (cost?.totalAmount?.amount
      ? {
          amount: (parseFloat(cost.totalAmount.amount) * (21 / 121)).toFixed(2),
          currencyCode: cost.totalAmount.currencyCode,
        }
      : null);

  // Any pre-order line holds the whole order (one parcel once every line
  // is on hand), so the summary says so above the VAT note.
  const hasPreorder = (cart?.lines?.nodes ?? []).some((line) =>
    Boolean(preorderNoteOf(line)),
  );

  return (
    <div aria-labelledby={summaryId} className={className}>
      {layout === 'page' ? (
        // Build-sheet register: hairline-ruled rows, mono tabular figures —
        // subtotal, the VAT share inside it, and the total the checkout
        // will charge.
        <dl role="group" className="cart-register">
          <div className="cart-register-row">
            <Txt id="cart.register_subtotal" as="dt" />
            <dd>
              {cost?.subtotalAmount?.amount ? (
                <Money data={cost.subtotalAmount} />
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div className="cart-register-row">
            <Txt id="cart.register_vat" as="dt" />
            <dd>{vatAmount ? <Money data={vatAmount} /> : '—'}</dd>
          </div>
          <div className="cart-register-row is-total">
            <Txt id="cart.register_total" as="dt" />
            <dd>
              {cost?.totalAmount?.amount ? (
                <Money data={cost.totalAmount} />
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <dl role="group" className="cart-subtotal">
          <Txt id="cart.subtotal" as="dt" />
          <dd>
            {cart?.cost?.subtotalAmount?.amount ? (
              <Money data={cart?.cost?.subtotalAmount} />
            ) : (
              '-'
            )}
          </dd>
        </dl>
      )}
      <CartCheckoutActions
        checkoutUrl={cart?.checkoutUrl}
        total={cost?.totalAmount ?? null}
      />
      {/* Quiet secondary actions under the CTA: an escape hatch back to the
          catalog so a populated cart isn't a dead end, and (page only) a
          share-this-cart link builder. */}
      <div className="cart-secondary-actions">
        <Link
          to="/collections/all"
          prefetch="viewport"
          className="cart-keep-shopping"
          onClick={layout === 'aside' ? close : undefined}
        >
          <Txt id="cart.keep_shopping" />
        </Link>
        {layout === 'page' ? <ShareCartButton cart={cart} /> : null}
      </div>
      {hasPreorder ? (
        <Txt id="cart.note_preorder" as="p" className="cart-summary-note" />
      ) : null}
      <Txt id="cart.note_vat" as="p" className="cart-summary-note" />
      <Txt id="cart.note_terms" as="p" className="cart-summary-note" />
      <CartGoalMeter />
    </div>
  );
}

/**
 * Copies a /cart/<variant>:<qty>,…?view=1 link reproducing the current cart,
 * including any applied discount codes (`&discount=CODE[,CODE]`). The
 * recipient lands on their own /cart for review (see cart.$lines.tsx),
 * not straight in checkout. Child bundle components are excluded (Shopify
 * re-expands those from the parent line).
 */
function ShareCartButton({cart}: {cart: CartSummaryProps['cart']}) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Don't let the 2s confirmation-reset timer fire into an unmounted
  // component (navigating away right after copying).
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const shareable = (cart?.lines?.nodes ?? []).filter(
    (line) =>
      !('parentRelationship' in line && line.parentRelationship?.parent),
  );
  if (!shareable.length) return null;

  // Carry the sender's applied discount codes so the recipient's cart
  // prices out the same. Applicable codes only — a dead code would just
  // error on the recipient's side.
  const discountCodes = (cart?.discountCodes ?? [])
    .filter((c) => c.applicable && c.code)
    .map((c) => c.code);
  const discountParam = discountCodes.length
    ? `&discount=${encodeURIComponent(discountCodes.join(','))}`
    : '';

  // Aggregate by variant — Shopify splits a line when a BXGY discount covers
  // only part of its quantity, and the link shouldn't repeat the variant.
  const qtyByVariant = new Map<string, number>();
  for (const line of shareable) {
    const id = line.merchandise.id.split('/').pop()!;
    qtyByVariant.set(id, (qtyByVariant.get(id) ?? 0) + (line.quantity ?? 1));
  }
  const path = `/cart/${[...qtyByVariant]
    .map(([id, qty]) => `${id}:${qty}`)
    .join(',')}?view=1${discountParam}`;

  function copy() {
    // Share intent (fires even when the clipboard falls back to the
    // prompt): a shared cart is our only word-of-mouth loop signal.
    trackEvent('Share Cart', {props: {source: attributionSource()}});
    const url = `${window.location.origin}${path}`;
    // No Clipboard API at all (http, ancient browser): the call below would
    // throw a *synchronous* TypeError that bypasses the rejection handler —
    // guard it and fall back to the prompt directly.
    if (!navigator.clipboard?.writeText) {
      window.prompt(
        copyText('cart.share_prompt') ?? 'Copy this cart link',
        url,
      );
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Clipboard blocked (permissions / non-secure context) — hand the
        // link over the old way.
        window.prompt(
          copyText('cart.share_prompt') ?? 'Copy this cart link',
          url,
        );
      },
    );
  }

  return (
    <button
      type="button"
      className="cart-share-btn"
      data-copied={copied || undefined}
      onClick={copy}
    >
      {copied ? (
        <Txt id="cart.share_copied" />
      ) : (
        <Txt id="cart.share_label" />
      )}
      {/* The visible label swap isn't announced by screen readers on its
          own — mirror the confirmation into a polite live region. */}
      <span aria-live="polite" className="sr-only">
        {copied ? (copyText('cart.share_copied_sr') ?? 'Cart link copied to clipboard') : ''}
      </span>
    </button>
  );
}

function CartCheckoutActions({
  checkoutUrl,
  total,
}: {
  checkoutUrl?: string;
  total?: {amount?: string | null; currencyCode?: string | null} | null;
}) {
  if (!checkoutUrl) return null;

  // Funnel event with the cart value as revenue, plus the chk:<day>
  // beacon (buy-rate denominator). Shared helper so the ShopPay express
  // path counts identically; see app/lib/growth/checkout-beacon.ts.
  const handleClick = () => {
    const amount = total?.amount ? parseFloat(total.amount) : NaN;
    trackCheckoutClick(
      Number.isFinite(amount) && total?.currencyCode
        ? {currency: total.currencyCode, amount}
        : null,
    );
  };

  return (
    <a
      href={checkoutUrl}
      target="_self"
      className="cart-checkout-cta"
      onClick={handleClick}
    >
      <Txt id="cart.checkout_cta" />
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    </a>
  );
}
