import type {MoneyV2} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';
import {AddToCartButton} from './AddToCartButton';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';

/**
 * One "buy it as a stack" offer: the paired board resolved to the size
 * that matches what the visitor is looking at, with BOTH SKUs on one
 * multi-line hand-off link (`?lines=SKU:1,SKU:1`), so a single click
 * puts the pair in the cart.
 *
 * Any pair discount is configured in Shopify and applied at checkout;
 * callers only pass a percent when that rule actually exists. When the
 * discounted board is the partner being added, pass its discounted
 * `price` plus the full price as `compareAtPrice`; when it is the board
 * the visitor is already buying, pass its name as `discountedLabel` so
 * the badge reads "OpenESC -10%".
 */
export type StackOffer = {
  key: string;
  /** Partner board name, e.g. "OpenFC Lite". */
  label: string;
  /** Matched size value, e.g. "20x20". */
  size?: string;
  /** Partner's displayed price. */
  price?: MoneyV2 | null;
  /** Partner's full price, struck through next to a discounted `price`. */
  compareAtPrice?: MoneyV2 | null;
  pct?: number;
  /** Name of the discounted board when it is NOT the partner. */
  discountedLabel?: string;
  /** The multi-line hand-off link for this pair. */
  href: string;
  /** Handle of the board the visitor is looking at, for event props. */
  product?: string | null;
  available: boolean;
  /** What the partner adds, for the inline wording: 'ESC', 'flight
   *  controller'. */
  adds?: string;
  /** Plain sum of both boards' prices, shown as the stack total. */
  total?: MoneyV2 | null;
};

/**
 * Wraps a primary buy control with a hover/focus flyout of stack offers,
 * the "one click more" upsell. Desktop reveals on hover of the CTA; touch
 * devices (no hover) render the offers as a slim row under it. With no
 * offers it renders the CTA untouched.
 */
export function StackQuickAdd({
  children,
  offers,
  onAdd,
  inline = false,
}: {
  /** The primary CTA (usually an AddToCartButton). */
  children: React.ReactNode;
  offers: StackOffer[];
  onAdd?: () => void;
  /** Always-visible row under the CTA (the product page buy box) instead
   *  of the hover flyout, worded "Add the matching ESC, stack total". */
  inline?: boolean;
}) {
  if (!offers.length) return <>{children}</>;
  return (
    <div className={`cta-stack-group${inline ? ' cta-stack-group--inline' : ''}`}>
      {children}
      <div className="cta-stack-flyout" aria-label="Buy as a stack">
        {offers.map((o) => (
          <AddToCartButton
            key={o.key}
            className="cta-stack-offer"
            href={o.href}
            product={o.product}
            disabled={!o.available}
            onClick={() => {
              // Stack-builder engagement, distinct from the generic Add
              // to Cart that also fires: which pairings sell, from where.
              trackEvent('Stack Toggle', {
                props: {
                  product: o.product ?? 'unknown',
                  partner: o.key,
                  surface: 'pdp',
                  source: attributionSource(),
                },
              });
              onAdd?.();
            }}
          >
            <span className="cta-stack-offer-plus" aria-hidden="true">
              +
            </span>
            <span className="cta-stack-offer-label">
              {inline
                ? `Add the matching ${o.adds ?? o.label}${o.size ? ` (${o.size})` : ''}`
                : `${o.label}${o.size ? ` · ${o.size}` : ''}`}
            </span>
            {inline && o.total ? (
              <span className="cta-stack-offer-price">
                Stack total {formatPrice(o.total.amount, o.total.currencyCode)}
              </span>
            ) : o.price ? (
              <span className="cta-stack-offer-price">
                {o.compareAtPrice ? (
                  <s className="cta-stack-offer-was">
                    {formatPrice(
                      o.compareAtPrice.amount,
                      o.compareAtPrice.currencyCode,
                    )}
                  </s>
                ) : null}
                {formatPrice(o.price.amount, o.price.currencyCode)}
              </span>
            ) : null}
            {/* The pct is off ONE board, never the pair: next to a struck
                partner price it reads as that line's cut; otherwise it
                must name the discounted board ("OpenESC -10%"). No side
                known, no claim. */}
            {o.pct && (o.discountedLabel || o.compareAtPrice) ? (
              <span className="cta-stack-offer-pct">
                {o.discountedLabel ? `${o.discountedLabel} ` : ''}−{o.pct}%
              </span>
            ) : null}
          </AddToCartButton>
        ))}
      </div>
    </div>
  );
}
