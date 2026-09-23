import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useState} from 'react';
import {AddToCartButton} from './AddToCartButton';
import {useComingSoon, useProductStatus} from '~/lib/coming-soon';
import {copyText} from '~/lib/copy';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import type {
  MappedProductOptions,
  ProductVariantFragment,
} from '~/lib/product-shapes';

export function ProductForm({
  productOptions,
  selectedVariant,
  hideOptionNames,
  buyUrl,
  buyDisabled,
  buyCtaLabel,
  quantity,
  maxQuantity = 50,
  maxQuantityNote,
  onQuantityChange,
}: {
  productOptions: MappedProductOptions[];
  selectedVariant: ProductVariantFragment | null;
  /** Option names already handled elsewhere (e.g. the comparison ladder
   *  owns the line's primary axis), so the pill grid skips them and
   *  renders only the buy button for that axis. */
  hideOptionNames?: string[];
  /** Hand-off link override. Bundle products render from their own page
   *  but hand off the *component* SKUs as separate lines, so the caller
   *  builds the multi-line link. Unset, the selected variant's own
   *  single-line link is used. */
  buyUrl?: string;
  buyDisabled?: boolean;
  buyCtaLabel?: string;
  /** Units to add. With `onQuantityChange` set, a stepper renders next to
   *  the button; the caller holds the number. */
  quantity?: number;
  /** The most one add may ask for: the cart line cap, or the units left in
   *  a paid preorder batch. */
  maxQuantity?: number;
  /** Shown under the buy row once the stepper reaches `maxQuantity`, so a
   *  clamped number is explained ("Max 50 per order"). */
  maxQuantityNote?: string;
  onQuantityChange?: (next: number) => void;
}) {
  const navigate = useNavigate();
  // Variant switches are server navigations; on a slow connection the pill
  // used to give no feedback until the new loader data landed (only the
  // global RouteProgress bar moved). Track which pill was clicked and mark
  // it aria-busy/is-pending until the navigation settles.
  const navigation = useNavigation();
  const location = useLocation();
  const [pendingOption, setPendingOption] = useState<string | null>(null);
  // Clear on idle (slow navigations) AND on search change (prefetched ones
  // settle inside one render batch without an observable 'loading' state).
  useEffect(() => {
    if (navigation.state === 'idle') setPendingOption(null);
  }, [navigation.state, location.search]);
  const isBundle = buyUrl !== undefined;
  // Pre-order products take the order now and ship later, so the CTA says
  // so; the bundle CTA is the caller's label and is unchanged.
  const productStatus = useProductStatus(selectedVariant?.product?.handle);
  const ctaLabelAvailable =
    productStatus === 'preorder'
      ? (copyText('product-chrome.buy_cta_preorder') ?? 'Pre-order')
      : 'Add to cart';
  const ctaLabelSoldOut = copyText('product-chrome.buy_stock_out') ?? 'Sold out';
  const hidden = new Set(
    (hideOptionNames ?? []).map((n) => n.trim().toLowerCase()),
  );
  // Belt and braces: the PDP already swaps this whole form for the notify
  // signup while a product is locked, so a locked shop renders no buy link.
  const soon = useComingSoon(selectedVariant?.product?.handle);
  const qty = Math.max(1, Math.min(maxQuantity, Math.round(quantity ?? 1)));
  // The single-line hand-off carries `qty`; the bundle link keeps its own
  // per-line counts.
  const href = buyUrl ?? withQuantity(selectedVariant?.cartAddUrl ?? '', qty);
  const disabled =
    soon ||
    !href ||
    (isBundle ? Boolean(buyDisabled) : !selectedVariant?.availableForSale);
  const amount = Number.parseFloat(selectedVariant?.price?.amount ?? '');
  return (
    <div className="product-form">
      {productOptions.map((option) => {
        // If there is only a single value in the option values, don't display the option
        if (option.optionValues.length === 1) return null;
        // Skip axes owned by another selector (the comparison ladder).
        if (hidden.has(option.name.trim().toLowerCase())) return null;

        return (
          <div key={option.name} className="mb-4">
            <h3 className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
              {option.name}
            </h3>
            <div className="product-options-grid">
              {option.optionValues.map((value) => {
                const {name, variantUriQuery, selected, available, exists} =
                  value;
                // SEO: render as a button with a scripted navigation so
                // bots do not index these as duplicated links.
                const pending = pendingOption === option.name + name;
                return (
                  <button
                    type="button"
                    className={`product-options-item${
                      exists && !selected ? ' link' : ''
                    }${pending ? ' is-pending' : ''}`}
                    key={option.name + name}
                    style={{
                      opacity: available ? 1 : 0.3,
                    }}
                    disabled={!exists}
                    aria-label={name}
                    aria-pressed={selected}
                    aria-busy={pending || undefined}
                    onClick={() => {
                      if (!selected) {
                        setPendingOption(option.name + name);
                        // Same event as the PDP's tier ladder: any
                        // user-initiated variant switch is one
                        // `Variant Select`.
                        trackEvent('Variant Select', {
                          props: {
                            product:
                              selectedVariant?.product?.handle ?? 'unknown',
                            variant: name,
                            source: attributionSource(),
                          },
                        });
                        void navigate(`?${variantUriQuery}`, {
                          replace: true,
                          preventScrollReset: true,
                        });
                      }
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            <br />
          </div>
        );
      })}
      {onQuantityChange && !isBundle ? (
        <div className="product-qty" role="group" aria-label={copyText('product-chrome.buy_qty_aria') ?? 'Quantity'}>
          <button
            type="button"
            className="product-qty-step"
            onClick={() => onQuantityChange(qty - 1)}
            disabled={disabled || qty <= 1}
            aria-label={copyText('product-chrome.buy_qty_decrease') ?? 'Decrease quantity'}
          >
            −
          </button>
          <input
            className="product-qty-value"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxQuantity}
            value={qty}
            disabled={disabled}
            aria-label={copyText('product-chrome.buy_qty_aria') ?? 'Quantity'}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(next)) onQuantityChange(Math.max(1, Math.min(maxQuantity, next)));
            }}
          />
          <button
            type="button"
            className="product-qty-step"
            onClick={() => onQuantityChange(qty + 1)}
            disabled={disabled || qty >= maxQuantity}
            aria-label={copyText('product-chrome.buy_qty_increase') ?? 'Increase quantity'}
          >
            +
          </button>
        </div>
      ) : null}
      <AddToCartButton
        href={href}
        disabled={disabled}
        product={selectedVariant?.product?.handle}
        revenue={
          Number.isFinite(amount) && selectedVariant?.price?.currencyCode
            ? {currency: selectedVariant.price.currencyCode, amount: amount * qty}
            : null
        }
      >
        {isBundle
          ? (buyCtaLabel ?? 'Add to cart')
          : selectedVariant?.availableForSale
            ? ctaLabelAvailable
            : ctaLabelSoldOut}
      </AddToCartButton>
      {onQuantityChange && !isBundle && maxQuantityNote && qty >= maxQuantity ? (
        <p className="product-qty-note" role="status">
          {maxQuantityNote}
        </p>
      ) : null}
    </div>
  );
}

/** The hand-off link with its `qty` field set; other links pass through. */
function withQuantity(href: string, qty: number): string {
  if (!href || qty === 1) return href;
  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  if (!params.has('sku')) return href;
  params.set('qty', String(qty));
  return `${path}?${params.toString()}`;
}
