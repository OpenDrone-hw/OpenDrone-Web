import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {Form, Link, redirect, useLoaderData, useRevalidator, useRouteLoaderData} from 'react-router';
import {shopifyImageUrl} from '~/lib/shopify-image';
import type {Route} from './+types/cart.$';
import {getCart, type ShopifyCart, type ShopifyCartLine} from '~/lib/shopify-storefront';
import {
  CART_CHECK,
  DATES_SEEN_FIELD,
  cartLineInfo,
  checkoutOpen,
  loadSessionCart,
  paidBatchMessage,
  splitPlan,
  variantLink,
  type CartLineInfo,
} from '~/lib/shopify-cart-action';
import {formatPrice, paysInOtherCurrency} from '~/lib/catalog';
import {parseBuilds} from '~/lib/build-recommendations';
import buildsJson from '../../content/builds.json';
import {lineDisplayName, variantCartNote, variantDisplayName} from '~/lib/product-content';
import {Txt} from '~/components/Txt';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {BLOCKED_COUNTRIES, countryName, shippingQuote} from '~/lib/shipping-rates';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import type {RootLoader} from '~/root';
import {
  CartAddError,
  postCart,
  storedShipCountry,
  storedSplitItems,
  storeShipCountry,
  storeSplitItems,
  type SplitItem,
} from '~/lib/cart-client';

const CART_KEY = 'shopifyCartId';
const BUILDS = parseBuilds(buildsJson);

/**
 * The cart holds one whole build: every part of one size in at least the
 * quantity a quad needs (a size-neutral receiver counts by handle). Then
 * nothing flies before the last part arrives, so splitting the order only
 * adds a second shipping charge.
 */
function holdsCompleteBuild(cart: ShopifyCart): boolean {
  const units = (match: (line: ShopifyCartLine) => boolean) =>
    cart.lines.filter(match).reduce((sum, line) => sum + line.quantity, 0);
  return BUILDS.builds.some((build) =>
    build.parts.every((part) => {
      const role = BUILDS.roles[part.role];
      const held = role.sizeNeutral
        ? units((line) => line.handle === role.handle)
        : units((line) => line.sku === part.sku);
      return held >= part.quantity;
    }),
  );
}

/** US import duty shown as a range, never added to the total. */
const US_DUTY_LOW = 0.35;
const US_DUTY_HIGH = 0.4;
const MAX_LINE_QUANTITY = 50;

/** A copy string with `{name}` placeholders filled, or the fallback. */
function t(key: string, fallback: string, vars: Record<string, string | number> = {}): string {
  return (copyText(`cart.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * The cart: every line with its quantity, total and, for a preorder, the
 * ship date it carries into checkout. While the store is closed, /cart and
 * the old /cart/<variant>:<qty> permalinks go to the product listing.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('cart.meta_title') ?? 'Cart',
    description: copyText('cart.meta_description') ?? '',
    robots: 'noindex,nofollow',
  });

export async function loader({context, params, request}: Route.LoaderArgs) {
  if (!checkoutOpen(context.env) || params['*']) throw redirect('/products', 301);
  const cart = await loadSessionCart(context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    logError: (message) => console.error('[shopify-cart] cart read failed', message),
  });
  // The campaign-aware catalog says which lines wait for which target and
  // how many paid-batch units are left. The cart still renders without it.
  let info: Record<string, CartLineInfo> = {};
  if (cart?.lines.length) {
    let catalog = null;
    try {
      catalog = await context.catalog.get();
    } catch (error) {
      console.error('[shopify-cart] catalog read failed', error instanceof Error ? error.message : 'unknown error');
    }
    info = cartLineInfo(cart, catalog);
  }
  const check = new URL(request.url).searchParams.get('check');
  return {cart, info, check};
}

type Removed = SplitItem[];

/** Every ISO 3166-1 country code, for the cart's destination picker. */
const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

export default function CartPage() {
  const {cart, info, check} = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData<RootLoader>('root');
  // Lines moved out for a second order: kept in this browser so the list
  // survives a reload and the trip through checkout.
  const [removed, setRemoved] = useState<Removed>([]);
  // The destination the shipping row quotes: the visitor's country until
  // the buyer picks another one.
  const [country, setCountry] = useState<string | null>(rootData?.visitorCountry ?? null);
  useEffect(() => {
    setRemoved(storedSplitItems());
    const picked = storedShipCountry();
    if (picked) setCountry(picked);
  }, []);
  const pickCountry = (code: string) => {
    setCountry(code);
    storeShipCountry(code);
  };
  const updateRemoved = (items: Removed) => {
    setRemoved(items);
    storeSplitItems(items);
  };
  return (
    <main className="cart page-shell">
      <header className="page-header">
        <p className="page-eyebrow"><Txt id="cart.eyebrow" /></p>
        <h1 className="page-title"><Txt id="cart.title" /></h1>
        <p className="page-description"><Txt id="cart.description" /></p>
      </header>
      {check === CART_CHECK.paidBatch || check === CART_CHECK.shipDate || check === CART_CHECK.mixedDates ? (
        <p className="cart-mixed-warning" role="alert">
          {check === CART_CHECK.paidBatch
            ? t('check_paid_batch', 'An item in your cart has more units than its paid batch has left. Lower the quantity where shown, then check out.')
            : check === CART_CHECK.shipDate
              ? t('check_ship_date', 'A ship date in your cart changed since you added the item. Check the dates below, then check out.')
              : t('check_mixed_dates', 'Items in your cart ship on different dates, and the whole order ships in one parcel when the last item is ready. Check the dates below, or order the later items separately, then check out.')}
        </p>
      ) : null}
      {removed.length ? (
        <SplitReminder items={removed} cartHasLines={Boolean(cart?.lines.length)} onChange={updateRemoved} />
      ) : null}
      {cart?.lines.length ? (
        <PopulatedCart
          cart={cart}
          info={info}
          country={country}
          onCountry={pickCountry}
          onSplit={(items) => updateRemoved([...removed.filter((r) => !items.some((i) => i.id === r.id)), ...items])}
        />
      ) : (
        <EmptyCart />
      )}
    </main>
  );
}

/**
 * The lines taken out for a second order, with their quantities. While this
 * order is still in the cart, each links to its product page; once the cart
 * is empty (the first order is checked out), one button adds the same
 * quantities back.
 */
function SplitReminder({
  items,
  cartHasLines,
  onChange,
}: {
  items: Removed;
  cartHasLines: boolean;
  onChange: (items: Removed) => void;
}) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addable = items.filter((item) => item.sku);
  const addBack = async () => {
    if (busy || !addable.length) return;
    setBusy(true);
    setError(null);
    try {
      await postCart('/api/shopify/cart', [
        ['intent', 'add'],
        ['lines', addable.map((item) => `${item.sku}:${item.quantity}`).join(',')],
      ]);
      onChange(items.filter((item) => !item.sku));
      void revalidator.revalidate();
    } catch (caught) {
      setError(
        caught instanceof CartAddError && (caught.status === 400 || caught.status === 409) && caught.message
          ? caught.message
          : (copyText('cart.line_update_failed') ?? 'Could not update. Try again.'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cart-mixed-warning" role="status">
      <p>
        {cartHasLines
          ? t('split_removed_waiting', 'Saved for a second order. Check out the order below first, then come back here to add these:')
          : t('split_removed_ready', 'Your second order is ready to add back to the cart:')}
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <Link to={item.href}>
              {t('split_item', '{quantity} x {name}', {quantity: item.quantity, name: item.name})}
            </Link>
          </li>
        ))}
      </ul>
      <div className="cart-secondary-actions">
        {addable.length ? (
          <button type="button" className="cart-keep-shopping" disabled={busy} onClick={() => void addBack()}>
            {busy
              ? t('split_adding', 'Adding…')
              : cartHasLines
                ? t('split_put_back', 'Put them back in this order')
                : t('split_add_back', 'Add these to the cart')}
          </button>
        ) : null}
        <button type="button" className="cart-keep-shopping" disabled={busy} onClick={() => onChange([])}>
          {t('split_dismiss', 'Clear this list')}
        </button>
      </div>
      {error ? <small className="cart-line-error" role="alert">{error}</small> : null}
    </div>
  );
}

function EmptyCart() {
  return (
    <section className="cart-empty">
      <h2 className="cart-empty-title"><Txt id="cart.empty_title" /></h2>
      <Link className="hero-cta-primary" to="/products"><Txt id="cart.empty_cta" /></Link>
    </section>
  );
}

function lineName(line: ShopifyCartLine): string {
  return lineDisplayName(line.handle, line.title, line.variantTitle);
}

/** Quantity changes in flight anywhere in the cart: totals are stale and
 *  checkout waits until Shopify has confirmed them. */
const PendingContext = createContext<(delta: number) => void>(() => {});

/** Country names for the picker, sorted by name, built once. */
let countryOptions: Array<{code: string; name: string}> | null = null;
function allCountries(): Array<{code: string; name: string}> {
  countryOptions ??= COUNTRY_CODES.map((code) => ({code, name: countryName(code)})).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
  return countryOptions;
}

/** The flat rate to the picked destination, with a picker to change it. */
function ShippingRow({country, onCountry}: {country: string | null; onCountry: (code: string) => void}) {
  const quote = shippingQuote(country);
  return (
    <div className="cart-register-row">
      <dt>
        <label htmlFor="cart-ship-country">{t('shipping_label_to', 'Shipping to')}</label>{' '}
        <select
          id="cart-ship-country"
          value={quote?.country ?? ''}
          onChange={(event) => onCountry(event.target.value)}
          style={{
            maxWidth: '11rem',
            font: 'inherit',
            color: 'inherit',
            background: 'transparent',
            border: '1px solid var(--color-border-strong)',
            borderRadius: '4px',
            padding: '0.1rem 0.25rem',
          }}
        >
          {quote ? null : <option value="">{t('shipping_pick', 'Choose a country')}</option>}
          {/* No shipping there, so not offered; only a visitor located in
              one sees it, selected, next to the "not available" line. */}
          {allCountries()
            .filter(({code}) => !BLOCKED_COUNTRIES.has(code) || code === quote?.country)
            .map(({code, name}) => (
              <option key={code} value={code}>{name}</option>
            ))}
        </select>
      </dt>
      <dd>
        {!quote
          ? t('shipping_at_checkout', 'at checkout')
          : quote.blocked
            ? t('shipping_blocked', 'not available')
            : formatPrice(quote.rate, 'EUR')}
      </dd>
    </div>
  );
}

/** For a US address: the duty the carrier will ask for, as a range worked
 *  out from the goods subtotal. Shown next to the total, never in it. */
function UsDutyEstimate({country, subtotal}: {country: string | null; subtotal: number}) {
  const quote = shippingQuote(country);
  if (!quote || quote.blocked || quote.duty !== 'us' || !(subtotal > 0)) return null;
  return (
    <p className="cart-summary-note cart-duty-estimate">
      {t(
        'note_us_estimate',
        'Estimated US import duty, paid to the carrier on delivery: about {low} to {high} (35 to 40% of the goods; US customs sets the amount). Not in the total above.',
        {
          low: formatPrice(subtotal * US_DUTY_LOW, 'EUR'),
          high: formatPrice(subtotal * US_DUTY_HIGH, 'EUR'),
        },
      )}
    </p>
  );
}

/** Who pays import duties, by visitor country: never collected at
 *  checkout; outside the EU the carrier collects them on delivery. */
function DutyNote({country}: {country: string | null}) {
  const quote = shippingQuote(country);
  // No shipping to this country: the checkout slot says so instead.
  if (quote?.blocked) return null;
  const duty = quote ? quote.duty : 'none';
  // Outside the EU: the US and International markets keep the same price
  // and charge no EU VAT (Shopify: taxes included in price), the same
  // sentence the product page buy box gives.
  const exportVat = (
    <p className="cart-summary-note">
      {t(
        'note_export_vat',
        'No EU VAT is charged on orders shipped outside the EU. The price is the same as the EU price.',
      )}
    </p>
  );
  const currencyNote =
    quote && paysInOtherCurrency(quote.country) ? (
      <p className="cart-summary-note">
        {t('note_currency', 'Prices are in euro. Your card issuer converts at its own rate.')}
      </p>
    ) : null;
  if (duty === 'us') {
    return (
      <>
        {exportVat}
        <Txt id="cart.note_us" as="p" className="cart-summary-note" />
        {currencyNote}
      </>
    );
  }
  if (duty === 'intl') {
    return (
      <>
        {exportVat}
        <Txt id="cart.note_intl" as="p" className="cart-summary-note" />
        {currencyNote}
      </>
    );
  }
  return (
    <>
      <Txt id="cart.note_vat" as="p" className="cart-summary-note" />
      <p className="cart-summary-note">
        <Link to="/shipping">{t('shipping_rates_link', 'Shipping rates for every country')}</Link>
      </p>
    </>
  );
}

function PopulatedCart({
  cart,
  info,
  country,
  onCountry,
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  country: string | null;
  onCountry: (code: string) => void;
  onSplit: (items: Removed) => void;
}) {
  const revalidator = useRevalidator();
  const [inFlight, setInFlight] = useState(0);
  const onPending = useCallback((delta: number) => setInFlight((n) => Math.max(0, n + delta)), []);
  const pending = inFlight > 0 || revalidator.state !== 'idle';

  const hasPreorder = cart.lines.some((line) => line.shipPromise);
  // One parcel per order: when lines ship at different times, the early
  // ones wait for the last. Lines waiting for different funding targets do
  // not ship together even when their promise reads the same.
  const groupOf = (line: ShopifyCartLine) => info[line.id]?.group ?? `date:${line.shipPromise ?? ''}`;
  const groups = new Set(cart.lines.map(groupOf));
  const mixed = groups.size > 1;
  const plan = mixed ? splitPlan(cart, info) : null;
  // Only funding targets: nothing ships sooner by splitting the order.
  const targetsOnly = mixed && [...groups].every((g) => g.startsWith('target:'));
  const quote = shippingQuote(country);
  const shipBlocked = quote?.blocked === true;
  // Subtotal plus the flat rate for the picked country; checkout confirms it.
  const estimatedTotal =
    quote && !quote.blocked
      ? {amount: Number(cart.subtotal.amount) + quote.rate, currencyCode: cart.subtotal.currencyCode}
      : null;
  const overLimit = cart.lines.some((line) => {
    const max = info[line.id]?.maxQuantity;
    return max != null && line.quantity > max;
  });
  const blocked = pending || overLimit;
  // The phone's sticky checkout bar steps aside while the checkout button
  // in the summary is on screen, so there are never two at once.
  const inflowCheckout = useRef<HTMLDivElement>(null);
  const [inflowVisible, setInflowVisible] = useState(false);
  useEffect(() => {
    const el = inflowCheckout.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setInflowVisible(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const pendingStyle = pending ? {opacity: 0.5} : undefined;

  const checkoutForm = (className: string) => shipBlocked ? (
    <p className="cart-summary-note" role="note">
      {t('checkout_blocked', 'We do not ship to {country}, so this order cannot be checked out.', {
        country: countryName(quote?.country ?? ''),
      })}{' '}
      <Link to="/end-use">{t('checkout_blocked_link', 'End-Use Policy')}</Link>
    </p>
  ) : (
    <Form
      method="post"
      action="/api/shopify/cart"
      onSubmit={(event) => {
        if (blocked) {
          event.preventDefault();
          return;
        }
        trackCheckoutClick({currency: cart.subtotal.currencyCode, amount: Number(cart.subtotal.amount)});
      }}
    >
      <input type="hidden" name="intent" value="checkout" />
      {/* This page shows the mixed-dates notice, so checkout may go on. */}
      {mixed ? <input type="hidden" name={DATES_SEEN_FIELD} value="1" /> : null}
      <button className={className} type="submit" disabled={blocked} aria-disabled={blocked || undefined}>
        {pending ? t('checkout_updating', 'Updating cart…') : <Txt id="cart.checkout_cta" />}
      </button>
    </Form>
  );

  return (
    <PendingContext.Provider value={onPending}>
      <section className="cart-main">
        <div className="cart-details">
          <div className="cart-sheet-head" aria-hidden="true">
            <Txt id="cart.sheet_head_item" className="cart-sheet-head-item" />
            <Txt id="cart.sheet_head_qty" className="cart-sheet-head-qty" />
            <Txt id="cart.sheet_head_total" className="cart-sheet-head-total" />
          </div>
          <ul className="cart-lines-scroll" aria-label={copyText('cart.sr_line_items') ?? 'Line items'}>
            {cart.lines.map((line) => (
              <CartLine key={line.id} line={line} info={info[line.id]} pending={pending} />
            ))}
          </ul>
        </div>
        <div className="cart-summary-page" aria-busy={pending || undefined}>
          <dl className="cart-register">
            <div className="cart-register-row">
              <Txt id="cart.register_subtotal" as="dt" />
              <dd style={pendingStyle}>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</dd>
            </div>
            <ShippingRow country={country} onCountry={onCountry} />
            {estimatedTotal ? (
              <div className="cart-register-row">
                <dt><strong>{t('register_estimated_total', 'Estimated total')}</strong></dt>
                <dd style={pendingStyle}>
                  <strong>{formatPrice(estimatedTotal.amount, estimatedTotal.currencyCode)}</strong>
                </dd>
              </div>
            ) : null}
          </dl>
          <UsDutyEstimate country={country} subtotal={Number(cart.subtotal.amount)} />
          <div ref={inflowCheckout}>{checkoutForm('cart-checkout-cta')}</div>
          {shipBlocked ? null : (
            <p className="cart-summary-note cart-checkout-domain">
              {t(
                'checkout_domain',
                "Checkout opens on opendrone.store, OpenDrone's secure Shopify checkout. You pay there.",
              )}
            </p>
          )}
          {mixed ? (
            <MixedWarning
              cart={cart}
              info={info}
              plan={plan}
              targetsOnly={targetsOnly}
              completeBuild={holdsCompleteBuild(cart)}
              onSplit={onSplit}
            />
          ) : null}
          <details className="cart-notes" open={mixed || undefined}>
            <summary>{t('notes_summary', 'How shipping and ship dates work')}</summary>
            {hasPreorder && !mixed ? <Txt id="cart.note_preorder" as="p" className="cart-summary-note" /> : null}
            <DutyNote country={country} />
          </details>
          <div className="cart-secondary-actions">
            <Link className="cart-keep-shopping" to="/products"><Txt id="cart.keep_shopping" /></Link>
          </div>
          <Txt id="cart.note_terms" as="p" className="cart-summary-note" />
        </div>
        {/* Phones: the summary sits below every line, so the total and the
            checkout button also ride along the bottom of the screen. */}
        <div className="cart-sticky-bar" data-hidden={inflowVisible ? '' : undefined}>
          <span>
            {estimatedTotal ? (
              <>
                {t('register_estimated_total', 'Estimated total')}{' '}
                <strong style={pendingStyle}>{formatPrice(estimatedTotal.amount, estimatedTotal.currencyCode)}</strong>
              </>
            ) : (
              <>
                <Txt id="cart.register_subtotal" />{' '}
                <strong style={pendingStyle}>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</strong>
              </>
            )}
          </span>
          {checkoutForm('cart-sticky-checkout')}
        </div>
      </section>
    </PendingContext.Provider>
  );
}

/**
 * Lines that ship at different times: each line's date, what a funding line
 * waits for, and, when some lines can ship sooner on their own, a button
 * that takes the rest out of this order so they can be ordered separately.
 */
function MixedWarning({
  cart,
  info,
  plan,
  targetsOnly,
  completeBuild,
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  plan: {keep: string[]; later: string[]} | null;
  targetsOnly: boolean;
  /** The cart is one whole build: nothing flies before its last part, so
   *  the box says so in one line and the split becomes a quiet link. */
  completeBuild: boolean;
  onSplit: (items: Removed) => void;
}) {
  const revalidator = useRevalidator();
  const onPending = useContext(PendingContext);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const names = (ids: string[]) =>
    cart.lines.filter((l) => ids.includes(l.id)).map(lineName).join(', ');

  const split = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!plan || busy) return;
    setBusy(true);
    setFailed(false);
    onPending(1);
    try {
      await postCart('/api/shopify/cart', [['intent', 'remove'], ...plan.later.map((id): [string, string] => ['lineId', id])]);
      onSplit(
        cart.lines
          .filter((l) => plan.later.includes(l.id))
          .map((l) => ({
            id: l.id,
            name: lineName(l),
            href: variantLink(l.handle, l.selectedOptions),
            sku: l.sku,
            quantity: l.quantity,
          })),
      );
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      onPending(-1);
      void revalidator.revalidate();
    }
  };

  const splitForm = (label: string, className: string) =>
    plan ? (
      <>
        <Form method="post" action="/api/shopify/cart" onSubmit={(event) => void split(event)}>
          <input type="hidden" name="intent" value="remove" />
          {plan.later.map((id) => <input key={id} type="hidden" name="lineId" value={id} />)}
          <button type="submit" className={className} disabled={busy}>
            {busy ? t('split_busy', 'Removing…') : label}
          </button>
        </Form>
        {failed ? (
          <small className="cart-line-error" role="alert">
            {copyText('cart.line_update_failed') ?? 'Could not update. Try again.'}
          </small>
        ) : null}
      </>
    ) : null;

  if (completeBuild) {
    return (
      <div className="cart-mixed-warning is-build" role="note">
        <p>{t('mixed_build_together', 'Your build ships together once the last part is ready.')}</p>
        {plan
          ? splitForm(
              t('split_early_link', 'Get the {keep} sooner (pays shipping twice)', {keep: names(plan.keep)}),
              'cart-split-link',
            )
          : null}
      </div>
    );
  }

  return (
    <div className="cart-mixed-warning" role="note">
      <Txt id={targetsOnly ? 'cart.mixed_targets_title' : 'cart.mixed_title'} as="p" />
      <ul>
        {cart.lines.map((line) => {
          const target = info[line.id]?.target;
          return (
            <li key={line.id}>
              <strong>{lineName(line)}</strong>: {line.shipPromise ?? copyText('cart.mixed_in_stock') ?? 'in stock'}
              {target ? (
                <small className="cart-mixed-target">
                  {t('mixed_target_count', '{ordered} of {units} ordered toward its funding target', {
                    ordered: target.ordered,
                    units: target.units,
                  })}
                </small>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Txt id={targetsOnly ? 'cart.mixed_targets_body' : 'cart.mixed_body'} as="p" />
      {plan ? (
        <>
          <p>
            {t(
              'mixed_split_short',
              'To get {keep} sooner, split this into two orders: {later} move to a list here, you check out the rest, then add them back as a second order. Each order pays its own shipping.',
              {keep: names(plan.keep), later: names(plan.later)},
            )}
          </p>
          {splitForm(t('split_cta_short', 'Split into two orders'), 'cart-split-button')}
        </>
      ) : null}
    </div>
  );
}

function CartLine({line, info, pending}: {line: ShopifyCartLine; info: CartLineInfo | undefined; pending: boolean}) {
  const options = line.selectedOptions.filter(
    ({name, value}) => !(name === 'Title' && value === 'Default Title'),
  );
  const max = info?.maxQuantity ?? null;
  return (
    <li className="cart-line cart-line--sheet">
      <div className="cart-sheet-row">
        {line.image ? (
          <img src={shopifyImageUrl(line.image.url, 112)} alt={line.image.altText ?? line.title} width={56} height={56} />
        ) : (
          <span className="cart-line-noimage" aria-hidden="true">{line.title.slice(4, 5) || line.title[0]}</span>
        )}
        <div className="cart-sheet-item">
          <Link to={variantLink(line.handle, line.selectedOptions)}><strong>{line.title}</strong></Link>
          {options.map(({name, value}) => <small key={name}>{name}: {variantDisplayName(line.handle, value)}</small>)}
          {options.map(({name, value}) => {
            const note = variantCartNote(line.handle, value);
            return note ? <small key={`${name}-note`} className="cart-line-note">{note}</small> : null;
          })}
          {line.shipPromise ? (
            <small className="cart-line-preorder">
              {copyText('cart.preorder_line_prefix') ?? 'Pre-order'} · {line.shipPromise}
            </small>
          ) : null}
          {max !== null && line.quantity > max ? (
            <small className="cart-line-error" role="alert">{paidBatchMessage(max, line.shipPromise)}</small>
          ) : max !== null && max < MAX_LINE_QUANTITY ? (
            <small>{t('paid_left', '{left} left in the paid batch', {left: max})}</small>
          ) : null}
        </div>
        <div className="cart-sheet-qty">
          <LineQuantity line={line} max={max === null ? MAX_LINE_QUANTITY : Math.min(MAX_LINE_QUANTITY, max)} />
        </div>
        <div className="cart-sheet-total" style={pending ? {opacity: 0.5} : undefined}>
          {formatPrice(line.total.amount, line.total.currencyCode)}
          {line.quantity > 1 ? (
            <small className="cart-sheet-unit">
              {(copyText('cart.line_each') ?? '{price} each').replace(
                '{price}',
                formatPrice(Number(line.total.amount) / line.quantity, line.total.currencyCode),
              )}
            </small>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * Quantity stepper. Clicks change the number at once and are sent together
 * a moment after the last one, so fast clicking never drops a step; the
 * control reports busy while Shopify confirms, and the cart holds checkout
 * until then. Without JavaScript each button is a plain form post that
 * reloads /cart.
 */
function LineQuantity({line, max}: {line: ShopifyCartLine; max: number}) {
  const revalidator = useRevalidator();
  const onPending = useContext(PendingContext);
  const [quantity, setQuantity] = useState(line.quantity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(false);

  // Take the server value once nothing of ours is in flight.
  useEffect(() => {
    if (!pending.current) setQuantity(line.quantity);
  }, [line.quantity]);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current) onPending(-1);
    },
    [onPending],
  );

  const begin = () => {
    if (!pending.current) onPending(1);
    pending.current = true;
  };

  const send = async (fields: Array<[string, string]>) => {
    setBusy(true);
    setError(null);
    try {
      await postCart('/api/shopify/cart', fields);
    } catch (caught) {
      // A 409 carries a sentence for the buyer (paid batch, stale line).
      setError(
        caught instanceof CartAddError && caught.status === 409 && caught.message
          ? caught.message
          : (copyText('cart.line_update_failed') ?? 'Could not update. Try again.'),
      );
      setQuantity(line.quantity);
    } finally {
      pending.current = false;
      setBusy(false);
      try {
        await revalidator.revalidate();
      } finally {
        onPending(-1);
      }
    }
  };

  const step = (event: React.FormEvent<HTMLFormElement>, next: number) => {
    event.preventDefault();
    if (next < 1 || (next > quantity && next > max)) return;
    setQuantity(next);
    begin();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void send([['intent', 'update'], ['lineId', line.id], ['quantity', String(next)]]);
    }, 400);
  };

  const remove = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.clearTimeout(timer.current);
    begin();
    void send([['intent', 'remove'], ['lineId', line.id]]);
  };

  return (
    <div className="cart-line-quantity cart-line-quantity--sheet" aria-busy={busy || undefined}>
      <div className="cart-sheet-stepper">
        <LineForm line={line} quantity={quantity - 1} disabled={quantity <= 1} onSubmit={(e) => step(e, quantity - 1)} label={copyText('cart.line_decrease_aria') ?? 'Decrease quantity'}>−</LineForm>
        <span className="cart-sheet-qty-value" aria-live="polite">{quantity}</span>
        <LineForm line={line} quantity={quantity + 1} disabled={quantity >= max} onSubmit={(e) => step(e, quantity + 1)} label={copyText('cart.line_increase_aria') ?? 'Increase quantity'}>+</LineForm>
      </div>
      <Form method="post" action="/api/shopify/cart" onSubmit={remove}>
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="lineId" value={line.id} />
        <button type="submit" disabled={busy}><Txt id="cart.line_remove" /></button>
      </Form>
      {error ? (
        <small className="cart-line-error" role="alert">{error}</small>
      ) : quantity >= max && max >= MAX_LINE_QUANTITY ? (
        <small className="cart-line-max">
          {t('line_max', 'Max {count} per order. For more, email contact@opendrone.be.', {count: MAX_LINE_QUANTITY})}
        </small>
      ) : null}
    </div>
  );
}

function LineForm({line, quantity, disabled, label, onSubmit, children}: {line: ShopifyCartLine; quantity: number; disabled?: boolean; label: string; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; children: React.ReactNode}) {
  return (
    <Form method="post" action="/api/shopify/cart" onSubmit={onSubmit}>
      <input type="hidden" name="intent" value="update" />
      <input type="hidden" name="lineId" value={line.id} />
      <input type="hidden" name="quantity" value={quantity} />
      <button type="submit" disabled={disabled} aria-label={label}>{children}</button>
    </Form>
  );
}
