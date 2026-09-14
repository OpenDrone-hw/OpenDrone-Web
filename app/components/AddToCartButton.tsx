import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';

/**
 * The buy button: a plain link to the shop's hand-off endpoint
 * (`<shop>/incutec/add?sku=…&qty=…&next=cart`), which adds the lines to
 * the visitor's own Odoo cart and redirects them to it.
 *
 * It was a Shopify `CartForm` submission into a local cart route. Odoo
 * owns the cart now (contract section 3), so there is nothing to submit:
 * the click fires the funnel events and the checkout beacon, then
 * navigates. Same classes, same label, same position on the page.
 */
export function AddToCartButton({
  children,
  disabled,
  href,
  product,
  revenue,
  onClick,
  className = 'btn-primary',
  ariaLabel,
  dataTip,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  /** The hand-off link, from `buyUrl()` or a variant's `cartAddUrl`. */
  href: string;
  /** Low-cardinality product handle for the funnel events. */
  product?: string | null;
  /** Line value, so Plausible can attach revenue to the click. */
  revenue?: {currency: string; amount: number} | null;
  onClick?: () => void;
  /** Button class — defaults to the primary CTA; stack/quick-add
   *  surfaces pass their own compact pill styles. */
  className?: string;
  ariaLabel?: string;
  /** Attr-driven CSS tooltip content (see .pod-buy-stack[data-tip]). */
  dataTip?: string;
}) {
  if (disabled) {
    return (
      <button
        type="button"
        disabled
        aria-label={ariaLabel}
        data-tip={dataTip}
        className={className}
      >
        <span className="btn-label">{children}</span>
      </button>
    );
  }

  return (
    <a
      href={href}
      aria-label={ariaLabel}
      data-tip={dataTip}
      className={className}
      onClick={(e) => {
        // The hand-off leaves this site, so every click is a checkout
        // click: the Plausible event plus the chk:<day> beacon that is
        // the buy-rate denominator (app/lib/growth/ledger.ts).
        trackEvent('Add to Cart', {
          props: {product: product ?? 'unknown', source: attributionSource()},
        });
        trackCheckoutClick(revenue ?? null);
        // Drop focus after the click so :focus-within doesn't pin
        // hover-revealed quick-add UI open once the pointer leaves.
        e.currentTarget.blur();
        onClick?.();
      }}
    >
      <span className="btn-label">{children}</span>
    </a>
  );
}
