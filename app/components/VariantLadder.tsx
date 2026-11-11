import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useState} from 'react';
import {ChoiceLadder, type ChoiceLadderItem} from '~/components/ChoiceLadder';
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
  offer,
}: {
  axis: string;
  variants: Record<string, VariantContent>;
  productOptions: MappedProductOptions[];
  activeValue: string;
  onSelect: (value: string) => void;
  /** Print each version's price on its button. Off while the product is
   *  not for sale, so a locked page never shows a price. */
  showPrices?: boolean;
  /** The chosen offer of a board with the buy now or pre-order choice. */
  offer?: 'buy_now' | 'preorder';
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
    // Only an editorial coming-soon tier is unselectable. A sold-out or
    // closed-checkout tier stays selectable so a visitor can read its specs,
    // contents and images; the buy button alone reflects availability.
    const disabled = Boolean(content.comingSoon);
    return {value, content, optionValue, disabled};
  });
  const tabValue = tiers.find((tier) => !tier.disabled && norm(tier.value) === norm(activeValue))?.value
    ?? tiers.find((tier) => !tier.disabled)?.value;

  const items: ChoiceLadderItem[] = tiers.map(({value, content, optionValue, disabled}) => {
    const comingSoon = Boolean(content.comingSoon);
    // Sold-out only when the catalog actually has the variant and
    // marks it unavailable. Pre-setup (no matching option) stays
    // selectable for preview.
    const soldOut = Boolean(optionValue && optionValue.exists && !optionValue.available);
    // Each version's own price on its button, as FPV shops show it on
    // the option: the buyer compares without clicking through.
    // Buy now or pre-order: the button shows the price of the chosen offer.
    const first = optionValue?.firstSelectableVariant;
    const shownVariant = offer === 'preorder' && first?.preorderOffer ? first.preorderOffer : first;
    const price =
      showPrices && !comingSoon && shownVariant
        ? formatPrice(
            shownVariant.price.amount,
            shownVariant.price.currencyCode,
          )
        : '';
    return {
      key: value,
      name: shopSize(content.label ?? value),
      selected: norm(value) === norm(activeValue),
      disabled,
      tone: comingSoon ? 'comingsoon' : soldOut ? 'soldout' : undefined,
      flag: comingSoon
        ? copyText('product-chrome.ladder_flag_coming_soon')
        : soldOut
          ? copyText('product-chrome.ladder_flag_sold_out')
          : undefined,
      price,
      pending: pendingValue === value,
    };
  });

  return (
    <ChoiceLadder
      ariaLabel={`${axis} ${copyText('product-chrome.ladder_aria_suffix') ?? ''}`}
      items={items}
      tabbableKey={tabValue}
      onSelect={(value) => {
        const tier = tiers.find((t) => t.value === value);
        if (!tier || tier.content.comingSoon) return;
        onSelect(value);
        const optionValue = tier.optionValue;
        if (optionValue?.variantUriQuery && !optionValue.selected) {
          setPendingValue(value);
          void navigate(`?${optionValue.variantUriQuery}`, {
            replace: true,
            preventScrollReset: true,
          });
        }
      }}
    />
  );
}
