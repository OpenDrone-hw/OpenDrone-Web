import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useState} from 'react';
import {motion} from 'motion/react';
import type {MappedProductOptions} from '~/lib/product-shapes';
import type {VariantContent} from '~/lib/product-content';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';

/**
 * The version selector for a product *line* (OpenRX: Lite/Lite-UFL/Mono/
 * Gemini; OpenESC: 20x20/30x30): one segmented button per version, name
 * and price. Clicking one both updates the on-page preview (`onSelect`)
 * and, when a matching catalog variant exists, navigates to select it so
 * price and stock follow.
 *
 * Editorial (`variants`, keyed by option value) is the source of truth
 * for which tiers exist. The catalog is matched in by name: we find the
 * option whose name equals `axis`, then the option value whose name
 * equals the editorial key (both case-insensitive, trimmed). Until Shopify
 * carries those variants the ladder still renders for preview and the
 * buy button uses the product's default variant.
 */
export function VariantLadder({
  axis,
  variants,
  productOptions,
  activeValue,
  onSelect,
  showPrices = false,
}: {
  axis: string;
  variants: Record<string, VariantContent>;
  productOptions: MappedProductOptions[];
  activeValue: string;
  onSelect: (value: string) => void;
  /** Print each version's price on its button. Off while the product is
   *  not for sale, so a locked page never shows a price. */
  showPrices?: boolean;
}) {
  const navigate = useNavigate();
  // The tier card previews instantly via onSelect, but price/stock/cart wiring
  // arrive with the server navigation. Mark the clicked tier busy until the
  // navigation settles so a slow connection reads as syncing, not as a broken
  // click (`.variant-tier.is-pending` pulses the card border).
  const navigation = useNavigation();
  const location = useLocation();
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  // Two clear triggers: state returning to idle covers slow navigations; the
  // search-string change covers prefetched ones that settle inside a single
  // render batch, where navigation.state never observably leaves 'idle'.
  useEffect(() => {
    if (navigation.state === 'idle') setPendingValue(null);
  }, [navigation.state, location.search]);

  const norm = (s: string) => s.trim().toLowerCase();
  const axisOption = productOptions.find((o) => norm(o.name) === norm(axis));

  const tiers = Object.entries(variants).map(([value, content]) => {
    const optionValue = axisOption?.optionValues.find(
      (v) => norm(v.name) === norm(value),
    );
    return {value, content, optionValue};
  });

  return (
    <div
      className="variant-ladder"
      role="radiogroup"
      aria-label={`${axis} ${copyText('product-chrome.ladder_aria_suffix') ?? ''}`}
    >
      <div className="variant-ladder-track">
        {tiers.map(({value, content, optionValue}) => {
          const selected = norm(value) === norm(activeValue);
          // Coming-soon: a designed model with no purchasable variant yet.
          // Editorial only: greyed and non-selectable whatever the catalog says.
          const comingSoon = Boolean(content.comingSoon);
          // Sold-out only when the catalog actually has the variant and
          // marks it unavailable. Pre-setup (no matching option) stays
          // selectable for preview.
          const soldOut = Boolean(
            optionValue && optionValue.exists && !optionValue.available,
          );
          const disabled = comingSoon || soldOut;
          // Each version's own price on its button, as FPV shops show it on
          // the option: the buyer compares without clicking through.
          const tierPrice =
            showPrices && !comingSoon && optionValue?.firstSelectableVariant
              ? formatPrice(
                  optionValue.firstSelectableVariant.price.amount,
                  optionValue.firstSelectableVariant.price.currencyCode,
                )
              : '';
          const pending = pendingValue === value;
          return (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              aria-busy={pending || undefined}
              className={`variant-tier${selected ? ' is-selected' : ''}${
                comingSoon ? ' is-comingsoon' : soldOut ? ' is-soldout' : ''
              }${pending ? ' is-pending' : ''}`}
              onClick={() => {
                if (comingSoon) return;
                onSelect(value);
                if (optionValue?.variantUriQuery && !optionValue.selected) {
                  setPendingValue(value);
                  void navigate(`?${optionValue.variantUriQuery}`, {
                    replace: true,
                    preventScrollReset: true,
                  });
                }
              }}
            >
              {selected ? (
                <motion.span
                  className="variant-tier-glow"
                  layoutId="variant-tier-glow"
                  transition={{type: 'spring', stiffness: 380, damping: 34}}
                  aria-hidden="true"
                />
              ) : null}
              <span className="variant-tier-head">
                <span className="variant-tier-name">{shopName(content.label ?? value)}</span>
                {comingSoon ? (
                  <span className="variant-tier-flag">
                    {copyText('product-chrome.ladder_flag_coming_soon')}
                  </span>
                ) : soldOut ? (
                  <span className="variant-tier-flag">
                    {copyText('product-chrome.ladder_flag_sold_out')}
                  </span>
                ) : null}
              </span>
              {tierPrice ? (
                <span className="variant-tier-price">{tierPrice}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A size as FPV shops write it: "20x20", not "20×20". */
function shopName(name: string): string {
  return name.replace(/(\d)\s*×\s*(\d)/g, '$1x$2');
}
