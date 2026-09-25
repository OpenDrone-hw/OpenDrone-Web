import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useId, useState} from 'react';
import {motion, useReducedMotion} from 'motion/react';
import {Check} from 'lucide-react';
import type {MappedProductOptions} from '~/lib/product-shapes';
import {shopSize, type VariantContent} from '~/lib/product-content';
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
  const groupId = useId();
  const reducedMotion = useReducedMotion();
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
    const disabled = Boolean(content.comingSoon || (optionValue?.exists && !optionValue.available));
    return {value, content, optionValue, disabled};
  });
  const tabValue = tiers.find((tier) => !tier.disabled && norm(tier.value) === norm(activeValue))?.value
    ?? tiers.find((tier) => !tier.disabled)?.value;

  return (
    <div
      className="variant-ladder"
      role="radiogroup"
      tabIndex={-1}
      aria-label={`${axis} ${copyText('product-chrome.ladder_aria_suffix') ?? ''}`}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + direction + buttons.length) % buttons.length;
        buttons[next].focus();
        buttons[next].click();
      }}
    >
      <div className="variant-ladder-track">
        {tiers.map(({value, content, optionValue, disabled}) => {
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
            <motion.button
              type="button"
              key={value}
              role="radio"
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              tabIndex={value === tabValue ? 0 : -1}
              whileTap={disabled || reducedMotion ? undefined : {scale: 0.98}}
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
                  layoutId={`${groupId}-selection`}
                  transition={reducedMotion ? {duration: 0} : {type: 'spring', stiffness: 500, damping: 38}}
                  aria-hidden="true"
                />
              ) : null}
              <span className="variant-tier-head">
                <span className="variant-tier-name">{shopSize(content.label ?? value)}</span>
                {comingSoon ? (
                  <span className="variant-tier-flag">
                    {copyText('product-chrome.ladder_flag_coming_soon')}
                  </span>
                ) : soldOut ? (
                  <span className="variant-tier-flag">
                    {copyText('product-chrome.ladder_flag_sold_out')}
                  </span>
                ) : selected ? (
                  <span className="variant-tier-check" aria-hidden="true">
                    <Check size={13} strokeWidth={3} />
                  </span>
                ) : null}
              </span>
              {tierPrice ? (
                <span className="variant-tier-price">{tierPrice}</span>
              ) : null}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
