import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';

/**
 * The buy button: a regular POST form to the shop's hand-off endpoint
 * (`<shop>/incutec/add`, fields `sku`, `qty`, `next`), which adds the lines to
 * the visitor's own Odoo cart and redirects them to it.
 *
 * POST prevents crawlers and link previewers from creating quotations by
 * following the public product link. The click still fires funnel events
 * before the browser navigates to Odoo.
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
  /** Button class: defaults to the primary CTA; stack/quick-add
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

  const target = new URL(href, 'https://opendrone.be');
  const action = href.startsWith('http')
    ? `${target.origin}${target.pathname}`
    : target.pathname;
  const fields = Array.from(target.searchParams.entries());
  const fieldOccurrences = new Map<string, number>();
  const keyedFields = fields.map(([name, value]) => {
    const signature = `${name}:${value}`;
    const occurrence = (fieldOccurrences.get(signature) ?? 0) + 1;
    fieldOccurrences.set(signature, occurrence);
    return {name, value, key: `${signature}:${occurrence}`};
  });

  return (
    <form
      action={action}
      method="post"
      className="add-to-cart-form"
      onSubmit={(e) => {
        // The hand-off leaves this site, so every click is a checkout
        // click: the Plausible event plus the chk:<day> beacon that is
        // the buy-rate denominator (app/lib/growth/ledger.ts).
        trackEvent('Add to Cart', {
          props: {product: product ?? 'unknown', source: attributionSource()},
        });
        trackCheckoutClick(revenue ?? null);
        // Drop focus after the click so :focus-within doesn't pin
        // hover-revealed quick-add UI open once the pointer leaves.
        e.currentTarget.querySelector('button')?.blur();
        onClick?.();
      }}
    >
      {keyedFields.map(({name, value, key}) => (
        <input key={key} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        aria-label={ariaLabel}
        data-tip={dataTip}
        className={className}
      >
        <span className="btn-label">{children}</span>
      </button>
    </form>
  );
}
