import {useId, useState} from 'react';
/** The cart's per-line limit (cart.$.tsx, products.$handle.tsx). */
const MAX_LINE_QUANTITY = 50;
import {useRouteLoaderData} from 'react-router';
import {ArrowUpRight, Fan, Mail, Package, RadioTower, ShoppingBag} from 'lucide-react';
import type {RootLoader} from '~/root';
import {Link} from '~/components/nav';
import {AddToCartButton} from '~/components/AddToCartButton';
import {InfoHint} from '~/components/InfoHint';
import {Txt} from '~/components/Txt';
import {useGeoShipLine} from '~/components/ShipChip';
import {copyFill, copyText} from '~/lib/copy';
import {useProductStatusResolver} from '~/lib/coming-soon';
import {cartAddUrl, formatPrice} from '~/lib/catalog';
import {isPurchasableStatus, shortShipPromise} from '~/lib/product-content';
import {BUILD_ROLES, buildModes, heroBuildSelection, modeAddUrl, stackOffer, type BuildMode, type HeroBuild} from '~/lib/hero-build';
import {ExpressBuy, useExpressRefusal} from '~/components/ExpressBuy';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {shortCampaignDate} from '~/lib/preorder-campaign';
import {SALES, salesDay} from '~/lib/sales-model';

/**
 * One build block per drone size, with the two ways to order it:
 * "Buy now" is the FC and ESC stack from stock, "Pre-order" the full build.
 * The rows are the chosen mode's parts at the chosen mode's prices, so the
 * button total is their sum, and one line under the button says when it
 * ships. Where the stack is not in stock for this buyer (outside the EU,
 * batch 1 sold) there is no choice to make and the block is the pre-order
 * build alone.
 *
 * Replaces `HeroStackOffer` plus `HeroBuildGuide` while `BATCH_CHOICE` is on
 * (`HeroBuild.choice`).
 */
export function HeroBuildChoice({
  build,
  onInspect,
  activePart,
}: {
  build: HeroBuild;
  onInspect?: (beat: string) => void;
  activePart?: string | null;
}) {
  const modes = buildModes(build);
  // Pre-order the full build by default; "Buy now" is the stack from stock.
  const [wanted, setWanted] = useState<BuildMode>('preorder');
  const mode: BuildMode = wanted === 'buy_now' && modes.buy_now ? 'buy_now' : 'preorder';
  const shown = modes[mode] ?? modes.preorder;
  // Every part is listed in both modes, so the block keeps one height and
  // the buyer sees what "Buy now" leaves out: a part that is not in the
  // chosen mode reads "Pre-order" where its price would be, and ticking it
  // (or its tag) switches the block to the pre-order build.
  const inMode = new Map(shown.parts.map((part) => [part.sku, part]));
  const rows = modes.preorder.parts.map((part) => ({part: inMode.get(part.sku) ?? part, later: !inMode.has(part.sku)}));
  const [selected, setSelected] = useState(() => new Set(build.parts.map((part) => part.sku)));
  const preorderPart = (sku: string) => {
    setWanted('preorder');
    setSelected((previous) => new Set(previous).add(sku));
  };
  const status = useProductStatusResolver();
  const sellable = (handle: string) => isPurchasableStatus(status(handle));
  // Global PUBLIC_COMING_SOON gate; fail closed when root data is missing.
  const comingSoon = useRouteLoaderData<RootLoader>('root')?.comingSoon ?? true;
  // Nothing is pre-order any more (a batch has landed): the build is bought, not pre-ordered.
  const ordinary = Boolean(useRouteLoaderData<RootLoader>('root')?.ordinaryShop);
  const selection = heroBuildSelection(shown, selected, sellable, comingSoon);
  const name = useId();
  const stack = stackOffer(build);
  const refusal = useExpressRefusal();
  // One quantity for both modes, in one slot: stacks bought now, or builds
  // pre-ordered. Never more stacks than batch 1 still holds.
  const [quantity, setQuantity] = useState(1);
  const maxQuantity = mode === 'buy_now' && stack ? Math.max(1, Math.min(MAX_LINE_QUANTITY, stack.max)) : MAX_LINE_QUANTITY;
  const qty = Math.min(quantity, maxQuantity);
  const say = (key: string, fallback: string, vars: Record<string, string | number> = {}) => copyFill(`home.${key}`, fallback, vars);

  // One short status line, for pre-order only: the stock lane's "in stock,
  // ships in days" is already the site banner.
  const shipBy = shortCampaignDate(salesDay(SALES.shipsBy));
  const statusLine = !selection.available
    ? null
    : ordinary
      ? say('choice_status_in_stock', 'In stock in {{stock_from}}')
      : mode === 'preorder' && shipBy
        ? say('build_ship_target', 'Ships by {date}', {date: shipBy})
        : null;

  const options: Array<{mode: BuildMode; title: string}> = [
    {mode: 'preorder', title: say('choice_preorder_short', 'Pre-order')},
    {mode: 'buy_now', title: say('choice_buy_now_short', 'Buy now')},
  ];
  const lineTotal = selection.total !== null ? Math.round(selection.total * 100 * qty) / 100 : null;

  return (
    <section
      className="hero-build-guide hero-build-choice"
      data-mode={mode}
      aria-label={copyFill('home.build_aria', '{size}-inch build', {size: build.size})}
    >
      <div className="hero-build-heading">
        <h2>
          {build.size}″ <Txt id="home.choice_title" fallback="build" />
        </h2>
        {/* "Parts, not a ready-to-fly drone" and what else a pilot needs. */}
        <InfoHint label={copyText('home.build_help_label') ?? 'About this build'} iconOnly>
          <Txt id="home.build_help" />
        </InfoHint>
      </div>
      {modes.buy_now ? (
        <fieldset className="hero-choice">
          <legend className="sr-only">{say('choice_legend', 'Buy now or pre-order')}</legend>
          {options.map((option) => (
            <label key={option.mode} className={`hero-choice-option${mode === option.mode ? ' is-selected' : ''}`}>
              <input
                type="radio"
                className="offer-card-input"
                name={name}
                value={option.mode}
                checked={mode === option.mode}
                onChange={() => setWanted(option.mode)}
              />
              <strong>{option.title}</strong>
            </label>
          ))}
        </fieldset>
      ) : null}
      <ul className="hero-build-parts" onWheel={(event) => event.stopPropagation()}>
        {rows.map(({part, later}) => {
          const included = !later && selected.has(part.sku);
          const available = part.available && sellable(part.handle);
          const role = BUILD_ROLES[part.role];
          const roleLabel = copyText(`home.build_role_${part.role}`) ?? role.label;
          const contents = (
            <>
              <span className="hero-build-thumb">
                {part.image ? (
                  <img src={shopifyImageUrl(part.image, 100)} alt="" width={38} height={38} loading="lazy" decoding="async" />
                ) : part.role === 'props' ? (
                  <Fan size={20} aria-hidden="true" />
                ) : part.role === 'antenna' ? (
                  <RadioTower size={20} aria-hidden="true" />
                ) : (
                  <Package size={20} aria-hidden="true" />
                )}
              </span>
              <span className="hero-build-name">
                <strong>
                  {part.quantity > 1 ? `${part.quantity}× ` : ''}
                  {part.title}
                </strong>
              </span>
            </>
          );
          return (
            <li
              key={part.sku}
              className={`hero-build-part${included || later ? '' : ' is-excluded'}${later ? ' is-later' : ''}${activePart === role.beat ? ' is-active' : ''}`}
            >
              <label className="hero-build-check">
                <input
                  type="checkbox"
                  checked={included}
                  aria-label={copyFill('home.build_include_aria', 'Include {part}', {part: part.title})}
                  onChange={() =>
                    later
                      ? preorderPart(part.sku)
                      : setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(part.sku)) next.delete(part.sku);
                      else next.add(part.sku);
                      return next;
                    })
                  }
                />
                <span aria-hidden="true" />
              </label>
              {onInspect ? (
                <button
                  type="button"
                  className="hero-build-inspect"
                  onClick={() => onInspect(role.beat)}
                  aria-label={copyFill('home.build_explore_aria', 'Explore {role}', {role: roleLabel})}
                >
                  {contents}
                </button>
              ) : (
                <Link className="hero-build-inspect" to={part.url} prefetch="intent">
                  {contents}
                </Link>
              )}
              <span className="hero-build-price">
                {later ? (
                  <button type="button" className="hero-build-later" onClick={() => preorderPart(part.sku)}>
                    {say('choice_later', 'Pre-order')}
                  </button>
                ) : !available ? (
                  <Txt id="home.build_unavailable" />
                ) : part.price === null || !selection.showPrices ? (
                  ''
                ) : (
                  formatPrice((part.price * part.quantity).toFixed(2), part.currency)
                )}
              </span>
              <Link
                className="hero-build-detail"
                to={part.url}
                prefetch="intent"
                aria-label={copyFill('home.build_view_aria', 'View {part}', {part: part.title})}
              >
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hero-build-buy">
        {selection.notify ? (
          <Link className="hero-build-add" to="/newsletter" prefetch="intent">
            <span className="btn-label">
              <Mail size={16} aria-hidden="true" />
              <Txt id="home.build_notify" />
            </span>
          </Link>
        ) : (
          <div className="hero-build-buyrow">
            <div className="product-qty hero-build-qty" role="group" aria-label={copyText('product-chrome.buy_qty_aria') ?? 'Quantity'}>
              <button type="button" className="product-qty-step" onClick={() => setQuantity(Math.max(1, qty - 1))} disabled={qty <= 1} aria-label={copyText('product-chrome.buy_qty_decrease') ?? 'Decrease quantity'}>
                −
              </button>
              <span className="product-qty-value" aria-live="polite">{qty}</span>
              <button type="button" className="product-qty-step" onClick={() => setQuantity(Math.min(maxQuantity, qty + 1))} disabled={qty >= maxQuantity} aria-label={copyText('product-chrome.buy_qty_increase') ?? 'Increase quantity'}>
                +
              </button>
            </div>
            {mode === 'buy_now' && stack ? (
              <ExpressBuy lines={stack.lines} quantity={qty} product={`stack-${build.id}`} className="hero-build-add" disabled={!selection.available}>
                <ShoppingBag size={16} aria-hidden="true" />
                {/* The block's title names the size; a phone drops it from the button. */}
                <span>{say('choice_buy_now_short', 'Buy now')}</span>
                {lineTotal !== null && selection.currency ? (
                  <span className="hero-build-total">{formatPrice(lineTotal.toFixed(2), selection.currency)}</span>
                ) : null}
              </ExpressBuy>
            ) : (
              <AddToCartButton
                href={modeAddUrl(cartAddUrl(build.addUrl, selection.parts.map((part) => ({sku: part.sku, quantity: part.quantity * qty}))), 'preorder')}
                disabled={!selection.available}
                product={`build-${build.id}`}
                className="hero-build-add"
                compactError
                revenue={lineTotal !== null && selection.currency ? {amount: lineTotal, currency: selection.currency} : null}
              >
                <ShoppingBag size={16} aria-hidden="true" />
                {ordinary ? say('choice_add_in_stock', 'Add to cart') : say('choice_preorder_short', 'Pre-order')}
                {lineTotal !== null && selection.currency ? (
                  <span className="hero-build-total">{formatPrice(lineTotal.toFixed(2), selection.currency)}</span>
                ) : null}
              </AddToCartButton>
            )}
          </div>
        )}
        {refusal && mode === 'buy_now' ? <p className="hero-build-ship cart-line-error" role="alert">{refusal}</p> : null}
        {statusLine && !selection.notify ? (
          <p className="hero-build-ship hero-build-status" role="status">{statusLine}</p>
        ) : null}
      </div>
    </section>
  );
}
