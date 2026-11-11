import {useId} from 'react';
import {copyFill, copyText} from '~/lib/copy';
import {formatPrice, offerSaving} from '~/lib/catalog';
import type {BatchOffer} from '~/lib/catalog';
import type {ProductVariantFragment} from '~/lib/product-shapes';

/** What one offer card says: every line is short, and a line with nothing
 *  to say is left out (no saving where both offers cost the same). */
export type OfferCard = {
  offer: BatchOffer;
  title: string;
  price: string;
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
export function offerCards(
  buyNow: Pick<ProductVariantFragment, 'price' | 'campaign'>,
  preorder: Pick<ProductVariantFragment, 'price' | 'campaign'>,
): [OfferCard, OfferCard] {
  const say = (key: string, fallback: string, vars: Record<string, string | number> = {}) =>
    copyFill(`product-chrome.${key}`, fallback, vars);
  const left = buyNow.campaign?.paidLeft ?? null;
  const saving = offerSaving(Number(buyNow.price.amount), Number(preorder.price.amount));
  const shipBy = preorder.campaign?.latestShip ?? null;
  return [
    {
      offer: 'buy_now',
      title: say('offer_buy_now', 'Buy now'),
      price: formatPrice(buyNow.price.amount, buyNow.price.currencyCode),
      ships: say('offer_buy_now_ships', 'Ships in a few working days'),
      where: say('offer_buy_now_where', 'From Belgium, EU only'),
      extra: left != null ? say('offer_left', '{count} left', {count: left}) : null,
    },
    {
      offer: 'preorder',
      title: say('offer_preorder', 'Pre-order'),
      price: formatPrice(preorder.price.amount, preorder.price.currencyCode),
      ships: shipBy ? say('offer_preorder_ships', 'Ships by {date}', {date: shipBy}) : say('offer_preorder_ships_plain', 'Ships with the next batch'),
      where: say('offer_preorder_where', 'Worldwide'),
      extra: saving !== null ? say('offer_save', 'Save {amount}', {amount: formatPrice(saving, preorder.price.currencyCode)}) : null,
    },
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
}: {
  buyNow: ProductVariantFragment;
  preorder: ProductVariantFragment;
  mode: BatchOffer;
  onChange: (mode: BatchOffer) => void;
}) {
  const name = useId();
  return (
    <fieldset className="offer-choice" data-offer-choice>
      <legend className="sr-only">{copyText('product-chrome.offer_legend') ?? 'Buy now or pre-order'}</legend>
      {offerCards(buyNow, preorder).map((card) => (
        <label key={card.offer} className={`offer-card${mode === card.offer ? ' is-selected' : ''}`} data-offer={card.offer}>
          <input
            type="radio"
            className="offer-card-input"
            name={name}
            value={card.offer}
            checked={mode === card.offer}
            onChange={() => onChange(card.offer)}
          />
          <span className="offer-card-head">
            <span className="offer-card-title">{card.title}</span>
            <span className="offer-card-price">{card.price}</span>
          </span>
          <span className="offer-card-line">{card.ships}</span>
          <span className="offer-card-line is-muted">
            {card.where}
            {card.extra ? <span className={`offer-card-extra is-${card.offer}`}>{card.extra}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
