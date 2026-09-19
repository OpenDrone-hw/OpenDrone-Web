import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useState} from 'react';
import {motion} from 'motion/react';
import {Check} from 'lucide-react';
import type {MappedProductOptions} from '~/lib/product-shapes';
import type {VariantContent} from '~/lib/product-content';
import {copyText} from '~/lib/copy';

/**
 * Comparison ladder - the variant selector for a product *line*
 * (OpenRX: Lite/Lite-UFL/Mono/Gemini; OpenESC: 20×20/30×30). Each tier
 * is a card showing the cells that differ between variants; clicking a
 * card both updates the on-page preview (`onSelect`) and, when a matching
 * catalog variant exists, navigates to select it so price and stock
 * follow.
 *
 * Editorial (`variants`, keyed by option value) is the source of truth
 * for which tiers exist. The catalog is matched in by name: we find the
 * option whose name equals `axis`, then the option value whose name
 * equals the editorial key (both case-insensitive, trimmed). Until Odoo
 * carries those variants the ladder still renders for preview and the
 * buy button uses the product's default variant.
 */
export function VariantLadder({
  axis,
  variants,
  productOptions,
  activeValue,
  onSelect,
  compact = false,
}: {
  axis: string;
  variants: Record<string, VariantContent>;
  productOptions: MappedProductOptions[];
  activeValue: string;
  onSelect: (value: string) => void;
  /** Compact mode: a single horizontal row of name-only pills (no axis label,
   *  spec line) - for the pinned mobile buy bar where space is tight
   *  but variant switching still needs to be reachable. */
  compact?: boolean;
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
      className={`variant-ladder${compact ? ' variant-ladder--compact' : ''}`}
      role="radiogroup"
      aria-label={`${axis} ${copyText('product-chrome.ladder_aria_suffix') ?? ''}`}
    >
      {compact ? null : (
        <p className="variant-ladder-axis">
          {axis}
          <span className="variant-ladder-axis-hint">
            {copyText('product-chrome.ladder_axis_hint')}
          </span>
        </p>
      )}
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
                <span className="variant-tier-name">{content.label ?? value}</span>
                {comingSoon ? (
                  <span className="variant-tier-flag">
                    {copyText('product-chrome.ladder_flag_coming_soon')}
                  </span>
                ) : soldOut ? (
                  <span className="variant-tier-flag">
                    {copyText('product-chrome.ladder_flag_sold_out')}
                  </span>
                ) : selected ? (
                  <span className="variant-tier-flag is-selected" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                ) : null}
              </span>
              {/* One line of the specs that actually differ, on EVERY card
                  so the tiers compare at a glance (maintainer, 2026-08-18: the
                  selected-only spec table hid the comparison and the prose
                  tagline said nothing a spec doesn't). Keys ride along for
                  screen readers only; keep the values short enough to hold
                  one line. */}
              {compact || !content.highlights.length ? null : (
                <span className="variant-tier-specs">
                  {content.highlights.map(([k, v], i) => (
                    <span className="variant-tier-spec" key={k}>
                      {i > 0 ? (
                        <span className="variant-tier-sep" aria-hidden="true">
                          ·
                        </span>
                      ) : null}
                      <span className="sr-only">{k}: </span>
                      {v}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
