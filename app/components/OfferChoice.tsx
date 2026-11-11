import {useId} from 'react';
import {Link} from 'react-router';
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
  /** The card's name in the pinned bar's one-row switch ("Buy now"). */
  pin: string;
  /** The price in the pinned bar's switch, shown even when both cost the same. */
  pinPrice: string;
  /** The offer's price, or null when both offers cost the same: the cards
   *  then differ only by when and where the board ships. */
  price: string | null;
  ships: string;
  where: string;
  /** "12 left" on buy now, "Save €2.90" on a cheaper pre-order, else null. */
  extra: string | null;
};

/**
 * The two cards of a board that is in stock and can be pre-ordered, both
 * about this board. Pure, so the wording is tested without a browser: the
 * saving is the price gap and is stated only when there is one.
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
  const samePrice = Number(buyNow.price.amount) === Number(preorder.price.amount);
  return [
    {
      offer: 'buy_now',
      title: say('offer_buy_now', 'Buy now'),
      pin: say('offer_pin_buy_now', 'Buy now'),
      pinPrice: formatPrice(buyNow.price.amount, buyNow.price.currencyCode),
      price: samePrice ? null : formatPrice(buyNow.price.amount, buyNow.price.currencyCode),
      ships: say('offer_buy_now_ships', 'In stock, ships in days'),
      where: say('offer_buy_now_where', 'From Belgium, EU only'),
      extra: left != null ? say('offer_left', '{count} left', {count: left}) : null,
    },
    {
      offer: 'preorder',
      title: say('offer_preorder', 'Pre-order'),
      pin: say('offer_pin_preorder', 'Pre-order'),
      pinPrice: formatPrice(preorder.price.amount, preorder.price.currencyCode),
      price: samePrice ? null : formatPrice(preorder.price.amount, preorder.price.currencyCode),
      ships: shipBy ? say('offer_preorder_ships', 'Ships by {date}', {date: shipBy}) : say('offer_preorder_ships_plain', 'Ships with the next batch'),
      where: say('offer_preorder_where', 'Worldwide'),
      extra: saving !== null ? say('offer_save', 'Save {amount}', {amount: formatPrice(saving, preorder.price.currencyCode)}) : null,
    },
  ];
}

/** The partner board a stack add-on offers beside this board, bought now. */
export type StackAddon = {
  /** "OpenESC 20x20". */
  name: string;
  /** The partner's Buy now price, formatted. */
  price: string;
  thumb: string | null;
};

/**
 * The add-on slot under the cards, the same in both lanes: one unticked
 * tick row for the partner board at the chosen lane's price ("Add the
 * OpenESC 20x20, +49.00"), and at its right a plain link to the full build
 * on the home page. A part without a partner board shows the link alone;
 * a lane that does not offer the partner leaves the slot's height empty.
 */
export function AddonRow({
  partner,
  checked,
  onChange,
  fullBuild,
}: {
  partner: StackAddon | null;
  checked: boolean;
  onChange: (checked: boolean) => void;
  fullBuild: {size: string; href: string} | null;
}) {
  return (
    <div className="offer-addon" data-stack-addon>
      {partner ? (
        <label className="offer-addon-row">
          <input type="checkbox" className="offer-addon-input" checked={checked} onChange={(event) => onChange(event.target.checked)} />
          {partner.thumb ? <img src={shopifyImageUrl(partner.thumb, 64)} alt="" width={22} height={22} loading="lazy" decoding="async" aria-hidden="true" /> : null}
          <span className="offer-addon-text">
            {copyFill('product-chrome.offer_addon', 'Add the {name}, +{price}', {name: partner.name, price: partner.price})}
          </span>
        </label>
      ) : <span />}
      {fullBuild ? (
        <Link prefetch="intent" to={fullBuild.href} className="offer-addon-build-link" data-full-build-link>
          {copyFill('product-chrome.full_build_link', 'See the full {size}-inch build', {size: fullBuild.size})}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * A product with one offer gets no selectable card: one full-width status
 * row on the cards' type scale, "Pre-order · Ships by 31 March 2027 ·
 * Worldwide", the saving at the right when there is one, no second price
 * (the headline above has it). `offer` picks which of the two cards the
 * row says; a product simply in stock reads "Buy now · In stock, ships in
 * days · From Belgium, EU only".
 */
export function OfferStatus({
  buyNow,
  preorder,
  offer = 'preorder',
}: {
  buyNow: Pick<ProductVariantFragment, 'price' | 'campaign'>;
  preorder: Pick<ProductVariantFragment, 'price' | 'campaign'>;
  offer?: BatchOffer;
}) {
  const card = offerCards(buyNow, preorder).find((c) => c.offer === offer)!;
  const extra = offer === 'preorder' ? card.extra : null;
  return (
    <p className="offer-status-row" data-offer-choice data-offer-single={offer}>
      <span className="offer-status-row-text">
        <span className="offer-status-row-title">{card.title}</span>
        <span aria-hidden="true"> · </span>
        {card.ships}
        <span aria-hidden="true"> · </span>
        <span className="is-muted">{card.where}</span>
      </span>
      {extra ? <span className="offer-status-row-extra">{extra}</span> : null}
    </p>
  );
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
  buyNow: Pick<ProductVariantFragment, 'price' | 'campaign'>;
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
            <span className="offer-card-pin">{card.pin}</span>
            <span className="offer-card-pinprice">{card.pinPrice}</span>
            {card.price ? <span className="offer-card-price">{card.price}</span> : null}
          </span>
          <span className="offer-card-line">{card.ships}</span>
          <span className="offer-card-line is-muted">{card.where}</span>
          {/* Always the slot, so a size without a saving keeps the card's height. */}
          <span className={`offer-card-line offer-card-extra is-${card.offer}`} aria-hidden={card.extra ? undefined : true}>
            {card.extra ?? '\u00a0'}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
