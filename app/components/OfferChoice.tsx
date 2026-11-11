import {useId} from 'react';
import {copyFill, copyText} from '~/lib/copy';
import {formatPrice, offerSaving} from '~/lib/catalog';
import type {BatchOffer} from '~/lib/catalog';
import type {ProductVariantFragment} from '~/lib/product-shapes';
import {shopifyImageUrl} from '~/lib/shopify-image';

/** What one offer card says: every line is short, and a line with nothing
 *  to say is left out (no saving where both offers cost the same). */
export type OfferCard = {
  offer: BatchOffer;
  title: string;
  /** The card's name in the pinned bar's one-row switch ("Stack now"). */
  pin: string;
  /** Small pictures of the boards a stack card sells. */
  thumbs?: Array<string | null>;
  /** The offer's price, or null when both offers cost the same: the cards
   *  then differ only by when and where the board ships. */
  price: string | null;
  ships: string;
  where: string;
  /** "12 left" on buy now, "Save €2.90" on a cheaper pre-order, else null. */
  extra: string | null;
};

/**
 * The two cards of a board that is in stock and can be pre-ordered. Pure, so
 * the wording is tested without a browser: the saving is the price gap and
 * is stated only when there is one.
 */
export type StackCard = {size: string; price: number; currency: string; thumbs: Array<string | null>};

export function offerCards(
  buyNow: Pick<ProductVariantFragment, 'price' | 'campaign'>,
  preorder: Pick<ProductVariantFragment, 'price' | 'campaign'>,
  stack: StackCard | null = null,
): [OfferCard, OfferCard] {
  const say = (key: string, fallback: string, vars: Record<string, string | number> = {}) =>
    copyFill(`product-chrome.${key}`, fallback, vars);
  const left = buyNow.campaign?.paidLeft ?? null;
  const saving = offerSaving(Number(buyNow.price.amount), Number(preorder.price.amount));
  const shipBy = preorder.campaign?.latestShip ?? null;
  const samePrice = Number(buyNow.price.amount) === Number(preorder.price.amount);
  const preorderCard: OfferCard = {
    offer: 'preorder',
    title: say('offer_preorder', 'Pre-order'),
    pin: say('offer_pin_preorder', 'Pre-order'),
    price: samePrice && !stack ? null : formatPrice(preorder.price.amount, preorder.price.currencyCode),
    ships: shipBy ? say('offer_preorder_ships', 'Ships by {date}', {date: shipBy}) : say('offer_preorder_ships_plain', 'Ships with the next batch'),
    where: say('offer_preorder_where', 'Worldwide'),
    extra: saving !== null ? say('offer_save', 'Save {amount}', {amount: formatPrice(saving, preorder.price.currencyCode)}) : null,
  };
  // The stack: this board and its partner of the same size, bought now.
  if (stack) {
    return [
      {
        offer: 'buy_now',
        title: say('offer_stack', 'FC and ESC stack'),
        pin: say('offer_pin_stack', 'Stack now'),
        thumbs: stack.thumbs,
        price: formatPrice(stack.price.toFixed(2), stack.currency),
        ships: say('offer_buy_now_ships', 'In stock, ships in days'),
        where: say('offer_buy_now_where', 'From Belgium, EU only'),
        extra: null,
      },
      preorderCard,
    ];
  }
  return [
    {
      offer: 'buy_now',
      title: say('offer_buy_now', 'Buy now'),
      pin: say('offer_pin_buy_now', 'Buy now'),
      price: samePrice ? null : formatPrice(buyNow.price.amount, buyNow.price.currencyCode),
      ships: say('offer_buy_now_ships', 'In stock, ships in days'),
      where: say('offer_buy_now_where', 'From Belgium, EU only'),
      extra: left != null ? say('offer_left', '{count} left', {count: left}) : null,
    },
    preorderCard,
  ];
}

/**
 * "Buy now" or "Pre-order" as two cards: a native radio group, so Tab
 * reaches it once, the arrow keys move the choice, and a screen reader
 * announces each card as one radio with its price, ship date and area.
 * Side by side where two fit, stacked on a phone.
 */
export function OfferChoice({
  buyNow,
  preorder,
  mode,
  onChange,
  stack = null,
  single = null,
  solo = false,
}: {
  /** No Buy now lane for this visitor (outside the EU, batch 1 gone): the
   *  pre-order card alone, in the same place and type as beside Buy now.
   *  `buyNow` then only carries the retail price the saving is read from. */
  solo?: boolean;
  buyNow: Pick<ProductVariantFragment, 'price' | 'campaign'>;
  preorder: ProductVariantFragment;
  mode: BatchOffer;
  onChange: (mode: BatchOffer) => void;
  /** The stack this board makes with its partner, when both are in stock. */
  stack?: StackCard | null;
  /** The quiet "Just this board" express link under the stack card. */
  single?: React.ReactNode;
}) {
  const name = useId();
  return (
    <fieldset className={`offer-choice${solo ? ' is-solo' : ''}`} data-offer-choice>
      <legend className="sr-only">{copyText('product-chrome.offer_legend') ?? 'Buy now or pre-order'}</legend>
      {offerCards(buyNow, preorder, stack).filter((card) => !solo || card.offer === 'preorder').map((card) => (
        <label key={card.offer} className={`offer-card${mode === card.offer || solo ? ' is-selected' : ''}`} data-offer={card.offer}>
          <input
            type="radio"
            className="offer-card-input"
            name={name}
            value={card.offer}
            checked={mode === card.offer || solo}
            onChange={() => onChange(card.offer)}
          />
          <span className="offer-card-head">
            {card.thumbs ? (
              <span className="offer-card-thumbs" aria-hidden="true">
                {card.thumbs.map((src, i) => (src ? <img key={i} src={shopifyImageUrl(src, 64)} alt="" width={22} height={22} loading="lazy" decoding="async" /> : null))}
              </span>
            ) : null}
            <span className="offer-card-title">{card.title}</span>
            <span className="offer-card-pin">{card.pin}</span>
            {card.price ? <span className="offer-card-price">{card.price}</span> : null}
          </span>
          <span className="offer-card-line">{card.ships}</span>
          <span className="offer-card-line is-muted">{card.where}</span>
          {card.extra ? <span className={`offer-card-line offer-card-extra is-${card.offer}`}>{card.extra}</span> : null}
        </label>
      ))}
      {/* One row under the cards in both modes, so choosing moves nothing. */}
      {single ? <div className="offer-choice-foot">{single}</div> : null}
    </fieldset>
  );
}
