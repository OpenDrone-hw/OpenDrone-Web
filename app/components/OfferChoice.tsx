import {Link} from 'react-router';
import {copyFill, copyText} from '~/lib/copy';
import {laneShipping} from '~/lib/sales-model';
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
  const lane = laneShipping(preorder.campaign);
  const samePrice = Number(buyNow.price.amount) === Number(preorder.price.amount);
  return [
    {
      offer: 'buy_now',
      title: say('offer_buy_now', 'Buy now'),
      pin: say('offer_pin_buy_now', 'Buy now'),
      pinPrice: formatPrice(buyNow.price.amount, buyNow.price.currencyCode),
      price: samePrice ? null : formatPrice(buyNow.price.amount, buyNow.price.currencyCode),
      ships: say('offer_buy_now_ships', 'In stock, ships in days'),
      where: say('offer_buy_now_where', 'From {{stock_from}}, {{stock_scope}} only'),
      extra: left != null ? say('offer_left', '{count} left', {count: left}) : null,
    },
    {
      offer: 'preorder',
      title: say('offer_preorder', 'Pre-order'),
      pin: say('offer_pin_preorder', 'Pre-order'),
      pinPrice: formatPrice(preorder.price.amount, preorder.price.currencyCode),
      price: samePrice ? null : formatPrice(preorder.price.amount, preorder.price.currencyCode),
      // No ship-by date: stock on hand says where it ships from and to; never an empty date.
      ships: lane.kind === 'date'
        ? say('offer_preorder_ships', 'Ships by {date}', {date: lane.date})
        : lane.kind === 'stock'
          ? say('offer_buy_now_ships', 'In stock, ships in days')
          : say('offer_preorder_ships_plain', 'Ships with the next batch'),
      where: lane.kind === 'stock'
        ? say('offer_buy_now_where', 'From {{stock_from}}, {{stock_scope}} only')
        : say('offer_preorder_where', 'Worldwide'),
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
  const found = offerCards(buyNow, preorder).find((c) => c.offer === offer)!;
  // A product simply in stock (no pre-order anywhere for it): "In stock · Ships in days".
  const card = offer === 'buy_now'
    ? {...found, title: copyText('product-chrome.offer_in_stock') ?? 'In stock', ships: copyText('product-chrome.offer_in_stock_ships') ?? 'Ships in days', where: copyFill('product-chrome.offer_in_stock_where', 'From {{stock_from}}')}
    : found;
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
