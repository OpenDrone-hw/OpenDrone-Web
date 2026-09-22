import {shopifyImageUrl} from '~/lib/shopify-image';
import {formatPrice} from '~/lib/catalog';
import {Link} from 'react-router';
import {ShoppingCart} from 'lucide-react';
import {AddToCartButton} from './AddToCartButton';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';

/** A stack companion for a pod row: one candidate partner board,
 *  size-matched, on one multi-line hand-off link so a single click puts
 *  the pair in the cart. */
export type PodCompanionOption = {
  key: string;
  /** Full name for tooltips/aria, e.g. "OpenESC · 20×20". */
  title: string;
  /** Chip label, e.g. "ESC" (renders as "+ESC"). */
  short: string;
  /** Displayed price. When the companion is the board a configured Shopify
   *  discount applies to, the host passes the derived discounted price. */
  price?: {amount: string; currencyCode: string} | null;
  /** The companion's undiscounted price, set ONLY when `price` is the
   *  derived discounted one: the tooltip then shows "full -> discounted"
   *  so the pct never reads as a further cut on the shown price. */
  fullPrice?: {amount: string; currencyCode: string} | null;
  pct?: number;
  /** Short label of the board the pct is off (a promotion discounts ONE
   *  board, never the pair), e.g. "ESC". Without it the pct is not shown:
   *  an unattributed percent would read as pair-wide. */
  discountedShort?: string;
  /** The multi-line hand-off link for the pair. */
  href: string;
  available: boolean;
  imageUrl?: string | null;
};

export type ProductPodItem = {
  /** Stable key - a PDP handle, or a hero family id ('fc'/'esc'/'frame') the
   *  3D viewer uses to spotlight the matching mesh on hover. */
  key: string;
  to: string;
  title: string;
  subtitle?: string;
  imageUrl?: string | null;
  imageAlt?: string | null;
  price?: {amount: string; currencyCode: string} | null;
  /** Coming-soon product: a small SOON tag takes the price slot. Hosts also
   *  omit `buy` for these rows - there is nothing to add yet. */
  soon?: boolean;
  /** When set, the row grows a hover/focus-revealed action bar spanning the
   *  row width: one "<self> only" button and one "<self> + <partner> stack"
   *  button per companion (both lines, one click). Hosts without it (the
   *  hero showcase) render exactly as before. */
  buy?: {
    /** The single-line hand-off link for this row's own SKU. */
    href: string;
    /** Product handle for the funnel events. */
    product?: string | null;
    available: boolean;
    /** Short family name of the row's own product ("FC", "ESC") - names the
     *  buttons so it's unambiguous what each one adds. */
    selfShort?: string;
    companions?: PodCompanionOption[];
  };
};

// The site's fixed-locale formatter, so a price reads the same for every
// visitor and on the server and the client.
const fmt = (p?: {amount: string; currencyCode: string} | null) =>
  p ? formatPrice(p.amount, p.currencyCode) : '';

/**
 * A row/grid of product thumbnails - the SHARED content behind both the hero
 * product showcase and the header family dropdowns (one component, two mounts).
 * Each pod links to its PDP and emits its key on hover/focus so a host (the
 * hero) can spotlight the matching 3D model. Hover cue is brightness/opacity -
 * no underlines.
 *
 * Buyable rows (header dropdowns) render a fixed-width buy cell that exists
 * BEFORE any pointer event: an ADD chip and a stack chip with an overlapped
 * two-board glyph. Nothing appears, moves, or resizes on hover - the only
 * hover effect is color. Deal detail lives in an attr-driven tooltip.
 */
export function ProductPods({
  items,
  onHover,
  onAdd,
  layout = 'row',
}: {
  items: ProductPodItem[];
  /** Fired with the item key on hover/focus, and null on leave/blur. */
  onHover?: (key: string | null) => void;
  /** Fired after any add-to-cart in the pod (hosts close the menu + open
   *  the cart drawer). */
  onAdd?: () => void;
  layout?: 'row' | 'grid';
}) {
  return (
    <div className={`product-pods product-pods--${layout}`}>
      {items.map((it) => {
        const link = (
          <Link
            key={it.key}
            to={it.to}
            className="product-pod"
            prefetch="intent"
            viewTransition
            preventScrollReset
            onMouseEnter={it.buy ? undefined : () => onHover?.(it.key)}
            onMouseLeave={it.buy ? undefined : () => onHover?.(null)}
            onFocus={it.buy ? undefined : () => onHover?.(it.key)}
            onBlur={it.buy ? undefined : () => onHover?.(null)}
          >
            <span className="product-pod-media">
              {it.imageUrl ? (
                <img
                  loading="lazy"
                  src={shopifyImageUrl(it.imageUrl, 160)}
                  alt={it.imageAlt ?? ''}
                  decoding="async"
                />
              ) : (
                <span className="product-pod-media-ph" aria-hidden="true" />
              )}
            </span>
            <span className="product-pod-text">
              <span className="product-pod-title">{it.title}</span>
              {it.subtitle ? (
                <span className="product-pod-subtitle">{it.subtitle}</span>
              ) : null}
            </span>
            {it.soon ? (
              <span className="product-pod-soon">Soon</span>
            ) : it.price ? (
              <span className="product-pod-price">{fmt(it.price)}</span>
            ) : null}
          </Link>
        );

        if (!it.buy) return link;

        const self = it.buy.selfShort ?? 'board';
        return (
          <div
            key={it.key}
            className="product-pod-wrap"
            onMouseEnter={() => onHover?.(it.key)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(it.key)}
            onBlur={() => onHover?.(null)}
          >
            {link}
            {/* Hover/focus-revealed action bar across the full row width.
                Every button says exactly what it adds: "<FC> only" vs
                "<FC> + <ESC> stack". Keyboard: focusing a button opens the
                bar via :focus-within. */}
            <div
              className="product-pod-actionbar"
              role="group"
              aria-label={`Buy ${it.title}`}
            >
              <AddToCartButton
                className="pod-buy-add"
                href={it.buy.href}
                product={it.buy.product}
                disabled={!it.buy.available}
                onClick={onAdd}
                ariaLabel={`Add ${it.title} to cart`}
              >
                <ShoppingCart size={15} strokeWidth={2.25} aria-hidden="true" />
                {self} only
                {it.price ? (
                  <span className="pod-buy-price">{fmt(it.price)}</span>
                ) : null}
              </AddToCartButton>
              {(it.buy.companions ?? []).map((o) => (
                <AddToCartButton
                  key={o.key}
                  className="pod-buy-stack"
                  href={o.href}
                  product={it.buy?.product}
                  disabled={!o.available}
                  onClick={() => {
                    // Stack-builder engagement from the header/listing
                    // pods. The row's product handle is the
                    // low-cardinality id, never it.key (a SKU on tier rows).
                    trackEvent('Stack Toggle', {
                      props: {
                        product: it.buy?.product ?? 'unknown',
                        partner: o.key,
                        surface: 'pod',
                        source: attributionSource(),
                      },
                    });
                    onAdd?.();
                  }}
                  ariaLabel={`Add ${it.title} and ${o.title} as a stack${
                    o.pct && o.discountedShort
                      ? `, ${o.discountedShort} ${o.pct}% off in the cart`
                      : ''
                  }`}
                  dataTip={
                    o.available
                      ? // When the shown price is already the derived
                        // discounted one, spell out full -> discounted so
                        // the pct can't read as a further cut on it.
                        o.fullPrice && o.pct && o.discountedShort
                        ? `${o.title} · +${fmt(o.fullPrice)} → ${fmt(o.price)} (${o.discountedShort} −${o.pct}% in the cart)`
                        : `${o.title} · +${fmt(o.price)}${
                            o.pct && o.discountedShort
                              ? ` · ${o.discountedShort} −${o.pct}% in the cart`
                              : ''
                          }`
                      : 'Out of stock'
                  }
                >
                  {it.imageUrl && o.imageUrl ? (
                    <span className="pod-stack-glyph" aria-hidden="true">
                      <img
                        src={shopifyImageUrl(it.imageUrl, 64)}
                        alt=""
                        width={18}
                        height={18}
                        loading="lazy"
                      />
                      <img
                        src={shopifyImageUrl(o.imageUrl, 64)}
                        alt=""
                        width={18}
                        height={18}
                        loading="lazy"
                      />
                    </span>
                  ) : null}
                  <span className="pod-buy-stack-label">
                    {self} + {o.short} stack
                  </span>
                  {o.pct && o.discountedShort ? (
                    <span className="pod-buy-stack-pct">
                      {o.discountedShort} −{o.pct}%
                    </span>
                  ) : null}
                </AddToCartButton>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
