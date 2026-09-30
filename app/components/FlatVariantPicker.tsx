import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useId, useState} from 'react';
import {motion, useReducedMotion} from 'motion/react';
import {Check} from 'lucide-react';
import type {ProductVariantFragment} from '~/lib/product-shapes';
import type {ProductContent} from '~/lib/product-content';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';

const norm = (s: string) => s.trim().toLowerCase();

/** One card of a flattened picker: a tier and a second-axis value. */
export type FlatChoice = {
  tier: string;
  second: string;
  label: string;
  variant: ProductVariantFragment | null;
};

const optionOf = (v: ProductVariantFragment, axis: string) =>
  v.selectedOptions.find((o) => norm(o.name) === norm(axis))?.value;

/**
 * The cards of a product that opts into `flatPicker`: tier order, then the
 * second axis in `secondOrder`, each matched to its catalog variant by both
 * option values. Combinations the content lacks a label for are skipped.
 */
export function flatChoices(
  content: Pick<ProductContent, 'optionAxis' | 'secondAxis' | 'secondOrder' | 'variants' | 'flatPicker'>,
  variants: ProductVariantFragment[],
): FlatChoice[] {
  if (!content.flatPicker || !content.optionAxis || !content.secondAxis) return [];
  const {optionAxis, secondAxis} = content;
  const out: FlatChoice[] = [];
  for (const [tier, tierContent] of Object.entries(content.variants ?? {})) {
    if (tierContent.comingSoon) continue;
    const seconds = [
      ...(content.secondOrder ?? []),
      ...Object.keys(tierContent.bySecond ?? {}).filter(
        (k) => !(content.secondOrder ?? []).some((o) => norm(o) === norm(k)),
      ),
    ];
    for (const second of seconds) {
      const label = tierContent.bySecond?.[second]?.label;
      if (!label) continue;
      const variant =
        variants.find(
          (v) => norm(optionOf(v, optionAxis) ?? '') === norm(tier) && norm(optionOf(v, secondAxis) ?? '') === norm(second),
        ) ?? null;
      out.push({tier, second, label, variant});
    }
  }
  return out;
}

/**
 * Two option axes as ONE row of cards (OpenMotor: 3" 6S, 3" 4S, 5" 6S, 5" 4S),
 * in the ladder's card style: name left, price right, a check on the selected
 * one. Picking a card selects the catalog variant carrying both values, by URL,
 * and previews its tier at once. `compact` is the pinned buy bar: chips with
 * the text before " · " as the name, no price.
 */
export function FlatVariantPicker({
  axis,
  choices,
  selectedVariant,
  secondAxis,
  onSelectTier,
  product,
  showPrices = false,
  compact = false,
}: {
  axis: string;
  secondAxis: string;
  choices: FlatChoice[];
  selectedVariant: ProductVariantFragment | null;
  onSelectTier: (tier: string) => void;
  product: string;
  showPrices?: boolean;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const groupId = useId();
  const reducedMotion = useReducedMotion();
  const navigation = useNavigation();
  const location = useLocation();
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (navigation.state === 'idle') setPending(null);
  }, [navigation.state, location.search]);

  if (choices.length < 2) return null;
  const selectedKey = selectedVariant
    ? `${norm(optionOf(selectedVariant, axis) ?? '')}|${norm(optionOf(selectedVariant, secondAxis) ?? '')}`
    : '';

  return (
    <div
      className={`variant-ladder variant-ladder--flat${compact ? ' is-compact' : ''}`}
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
        {choices.map(({tier, second, label, variant}) => {
          const key = `${norm(tier)}|${norm(second)}`;
          const selected = key === selectedKey;
          const soldOut = Boolean(variant && !variant.availableForSale);
          const price =
            showPrices && !compact && variant ? formatPrice(variant.price.amount, variant.price.currencyCode) : '';
          const isPending = pending === key;
          return (
            <motion.button
              type="button"
              key={key}
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (!selectedKey && key === `${norm(choices[0].tier)}|${norm(choices[0].second)}`) ? 0 : -1}
              whileTap={reducedMotion ? undefined : {scale: 0.98}}
              aria-busy={isPending || undefined}
              className={`variant-tier${selected ? ' is-selected' : ''}${soldOut ? ' is-soldout' : ''}${
                isPending ? ' is-pending' : ''
              }`}
              onClick={() => {
                if (selected) return;
                trackEvent('Variant Select', {
                  props: {product, variant: `${tier} / ${second}`, source: attributionSource()},
                });
                onSelectTier(tier);
                setPending(key);
                const query = new URLSearchParams(location.search);
                query.set(axis, tier);
                query.set(secondAxis, second);
                void navigate(`?${query.toString()}`, {replace: true, preventScrollReset: true});
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
                <span className="variant-tier-name">{compact ? label.split(' · ')[0] : label}</span>
                {!compact && soldOut ? (
                  <span className="variant-tier-flag">{copyText('product-chrome.ladder_flag_sold_out')}</span>
                ) : !compact && selected ? (
                  <span className="variant-tier-check" aria-hidden="true">
                    <Check size={13} strokeWidth={3} />
                  </span>
                ) : null}
              </span>
              {price ? <span className="variant-tier-price">{price}</span> : null}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
