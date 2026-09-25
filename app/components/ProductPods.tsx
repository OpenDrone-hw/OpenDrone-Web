import {shopifyImageUrl} from '~/lib/shopify-image';
import {formatPrice} from '~/lib/catalog';
import {Link} from 'react-router';
import {ShoppingCart} from 'lucide-react';
import {AddToCartButton} from './AddToCartButton';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {copyFill, copyText} from '~/lib/copy';

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
    /** A set of N units on one link ("×4" for motors). */
    set?: {quantity: number; href: string};
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
 * Buyable rows (header dropdowns) show the price under the name and an
 * always-on column of icon buttons stacked in the row's height: a cart for
 * the board alone, and an overlapped two-board glyph per stack partner.
 * Nothing appears, moves, or resizes on hover; what each button adds is in
 * its tooltip and aria label.
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
              {/* A buyable row shows its price once, under the name; the
                  buttons beside it carry no text. */}
              {it.buy && it.price ? (
                <span className="product-pod-price">{fmt(it.price)}</span>
              ) : null}
            </span>
            {it.soon ? (
              <span className="product-pod-soon">
                {copyText('product-chrome.pod_soon') ?? 'Soon'}
              </span>
            ) : it.price && !it.buy ? (
              <span className="product-pod-price">{fmt(it.price)}</span>
            ) : null}
          </Link>
        );

        if (!it.buy) return link;

        const self =
          it.buy.selfShort ?? copyText('chrome.family_fallback_short') ?? 'board';
        const outOfStock = copyText('product-chrome.pod_out_of_stock') ?? 'Out of stock';
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
            {/* Always-on icon column, stacked in the row's height: a cart
                for this board alone, and the two-board glyph for the stack.
                No text on the buttons; the tooltip and aria label say
                exactly what each adds. */}
            <div
              className="product-pod-actionbar"
              role="group"
              aria-label={copyFill('product-chrome.pod_buy_aria', 'Buy {title}', {title: it.title})}
            >
              <AddToCartButton
                className="pod-buy-add"
                href={it.buy.href}
                product={it.buy.product}
                disabled={!it.buy.available}
                onClick={onAdd}
                ariaLabel={copyFill('product-chrome.pod_add_aria', 'Add {title} {self} to cart', {
                  title: it.title,
                  self,
                })}
                dataTip={it.buy.available ? `${self} · ${fmt(it.price)}` : outOfStock}
              >
                <ShoppingCart size={18} strokeWidth={2.25} aria-hidden="true" />
              </AddToCartButton>
              {it.buy.set ? (
                <AddToCartButton
                  className="pod-buy-stack pod-buy-set"
                  href={it.buy.set.href}
                  product={it.buy.product}
                  disabled={!it.buy.available}
                  onClick={onAdd}
                  ariaLabel={copyFill(
                    'product-chrome.pod_add_set_aria',
                    'Add {quantity} × {title} {self} to cart',
                    {quantity: it.buy.set.quantity, title: it.title, self},
                  )}
                  dataTip={
                    it.buy.available
                      ? `${it.buy.set.quantity} × ${self} · ${fmt(
                          it.price
                            ? {
                                amount: (parseFloat(it.price.amount) * it.buy.set.quantity).toFixed(2),
                                currencyCode: it.price.currencyCode,
                              }
                            : null,
                        )}`
                      : outOfStock
                  }
                >
                  <span className="pod-buy-set-label">×{it.buy.set.quantity}</span>
                </AddToCartButton>
              ) : null}
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
                  ariaLabel={
                    o.pct && o.discountedShort
                      ? copyFill(
                          'product-chrome.pod_stack_aria_discount',
                          'Add {title} and {partner} as a stack, {board} {pct}% off in the cart',
                          {title: it.title, partner: o.title, board: o.discountedShort, pct: o.pct},
                        )
                      : copyFill(
                          'product-chrome.pod_stack_aria',
                          'Add {title} and {partner} as a stack',
                          {title: it.title, partner: o.title},
                        )
                  }
                  dataTip={
                    o.available
                      ? // When the shown price is already the derived
                        // discounted one, spell out full -> discounted so
                        // the pct can't read as a further cut on it.
                        o.fullPrice && o.pct && o.discountedShort
                        ? copyFill(
                            'product-chrome.pod_stack_tip_full',
                            '{self} + {partner} stack · +{full} → {price} ({board} −{pct}% in the cart)',
                            {
                              self,
                              partner: o.short,
                              full: fmt(o.fullPrice),
                              price: fmt(o.price),
                              board: o.discountedShort,
                              pct: o.pct,
                            },
                          )
                        : o.pct && o.discountedShort
                          ? copyFill(
                              'product-chrome.pod_stack_tip_discount',
                              '{self} + {partner} stack · +{price} · {board} −{pct}% in the cart',
                              {
                                self,
                                partner: o.short,
                                price: fmt(o.price),
                                board: o.discountedShort,
                                pct: o.pct,
                              },
                            )
                          : copyFill(
                              'product-chrome.pod_stack_tip',
                              '{self} + {partner} stack · +{price}',
                              {self, partner: o.short, price: fmt(o.price)},
                            )
                      : outOfStock
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
                  ) : (
                    <span className="pod-buy-stack-label">+{o.short}</span>
                  )}
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
