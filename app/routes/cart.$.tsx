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
import {
  fundingTargetTerms,
  lineDisplayName,
  setSize,
  shortShipPromise,
  variantCartNote,
  variantDisplayName,
} from '~/lib/product-content';
import {Txt} from '~/components/Txt';
import {ShipChip} from '~/components/ShipChip';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {
  BLOCKED_COUNTRIES,
  countryName,
  shipCountryOptions,
  shippingQuote,
} from '~/lib/shipping-rates';
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

/** Build-guide order of the parts: flight controller, ESC, frame, motors,
 *  receiver; anything else after them, in the order it was added. */
const GUIDE_ORDER = Object.values(BUILDS.roles).map((role) => role.handle);

function sortCartLines(lines: ShopifyCartLine[]): ShopifyCartLine[] {
  const rank = (line: ShopifyCartLine) => {
    const i = GUIDE_ORDER.indexOf(line.handle);
    return i < 0 ? GUIDE_ORDER.length : i;
  };
  return lines
    .map((line, i) => ({line, i}))
    .sort((a, b) => rank(a.line) - rank(b.line) || a.i - b.i)
    .map(({line}) => line);
}

/** Lines under one heading per ship date: dated batches first, funding
 *  targets after, anything in stock first of all. */
function groupCartLines(
  lines: ShopifyCartLine[],
): Array<{key: string; title: string; lines: ShopifyCartLine[]}> {
  const groups = new Map<string, {key: string; title: string; rank: number; lines: ShopifyCartLine[]}>();
  for (const line of lines) {
    const short = shortShipPromise(line.shipPromise);
    const key = short ? `${short.kind}:${short.text}` : 'stock';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: !short
          ? (copyText('cart.mixed_in_stock') ?? 'In stock')
          : short.kind === 'target'
            ? t('group_target', 'Funding target, {when}', {when: short.text})
            : short.text,
        rank: !short ? 0 : short.kind === 'target' ? 2 : 1,
        lines: [],
      };
      groups.set(key, group);
    }
    group.lines.push(line);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

/** "A", "A and B", "A, B and C". */
function joinNames(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
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

/** Put the picked destination on the Shopify cart so checkout opens in
 *  that country's market (see `/api/shopify/cart-country`). A blocked
 *  country is never sent; a failure leaves checkout to decide from the
 *  shipping address. */
function sendCartCountry(code: string) {
  if (BLOCKED_COUNTRIES.has(code)) return;
  const body = new URLSearchParams({country: code});
  fetch('/api/shopify/cart-country', {method: 'POST', body}).catch(() => {});
}

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
    if (picked) {
      setCountry(picked);
      if (picked !== rootData?.visitorCountry) sendCartCountry(picked);
    }
  }, []);
  const pickCountry = (code: string) => {
    setCountry(code);
    storeShipCountry(code);
    sendCartCountry(code);
  };
  const updateRemoved = (items: Removed) => {
    setRemoved(items);
    storeSplitItems(items);
  };
  return (
    <div className="cart page-shell">
      <header className="page-header">
        <h1 className="page-title"><Txt id="cart.title" /></h1>
        {cart?.lines.length ? (
          <p className="page-description">
            {t('description_review', 'Check your parts and ship dates, then pay on the secure checkout.')}
          </p>
        ) : null}
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
    </div>
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

/** The empty cart points at the two ways people start: the stack that
 *  ships in October, or the build guide for someone new to FPV. */
function EmptyCart() {
  return (
    <section className="cart-empty">
      <h2 className="cart-empty-title"><Txt id="cart.empty_title" /></h2>
      <ul className="cart-empty-cards">
        <li>
          <Link className="cart-empty-card" to="/products/openfc-lite" prefetch="intent">
            <strong>{t('empty_stack_title', 'Pre-order a stack (flight controller + ESC)')}</strong>
            <span>{t('empty_stack_body', 'Ships late October 2026')}</span>
          </Link>
        </li>
        <li>
          <Link className="cart-empty-card" to="/products#new-to-fpv" prefetch="intent">
            <strong>{t('empty_guide_title', 'New to FPV?')}</strong>
            <span>{t('empty_guide_body', 'See what a build needs')}</span>
          </Link>
        </li>
      </ul>
      <Link className="cart-keep-shopping" to="/products">{t('empty_all', 'All products')}</Link>
    </section>
  );
}

function lineName(line: ShopifyCartLine): string {
  return lineDisplayName(line.handle, line.title, line.variantTitle);
}

/** Quantity changes in flight anywhere in the cart: totals are stale and
 *  checkout waits until Shopify has confirmed them. */
const PendingContext = createContext<(delta: number) => void>(() => {});

/** Where most orders go, first in the picker. */
const COMMON_COUNTRIES = ['BE', 'NL', 'DE', 'FR', 'LU', 'GB', 'US'];

/** The picker in rate groups: the common destinations first, then the
 *  others by the flat-rate groups on /shipping, each by name. Blocked
 *  countries and territories with no postal address are left out. */
let countryGroups: Array<{label: string; options: Array<{code: string; name: string}>}> | null = null;
function pickerGroups(): Array<{label: string; options: Array<{code: string; name: string}>}> {
  if (countryGroups) return countryGroups;
  const all = shipCountryOptions('en').filter(({code}) => !COMMON_COUNTRIES.includes(code));
  const zoneOf = (code: string) => {
    const q = shippingQuote(code);
    return q && !q.blocked ? q.zone : 'world';
  };
  const pick = (zones: string[]) => all.filter(({code}) => zones.includes(zoneOf(code)));
  countryGroups = [
    {
      label: t('shipping_group_common', 'Common'),
      options: COMMON_COUNTRIES.map((code) => ({code, name: countryName(code)})),
    },
    {label: t('shipping_group_eu', 'European Union'), options: pick(['eu', 'eu_far', 'near', 'be'])},
    {label: t('shipping_group_europe', 'Rest of Europe'), options: pick(['europe'])},
    {label: t('shipping_group_world', 'Rest of the world'), options: pick(['us', 'world'])},
  ].filter((g) => g.options.length);
  return countryGroups;
}

/** The flat rate to the picked destination, with a picker to change it. */
function ShippingRow({country, onCountry}: {country: string | null; onCountry: (code: string) => void}) {
  const quote = shippingQuote(country);
  return (
    <div className="cart-register-row cart-ship-row">
      <dt>
        <label htmlFor="cart-ship-country">{t('shipping_label_ship_to', 'Ship to')}</label>
        <select
          id="cart-ship-country"
          className="cart-ship-select"
          value={quote?.country ?? ''}
          onChange={(event) => onCountry(event.target.value)}
        >
          {quote ? null : <option value="">{t('shipping_pick', 'Choose a country')}</option>}
          {/* No shipping there, so not offered; only a visitor located in
              one sees it, selected, next to the "not available" line. */}
          {quote && (BLOCKED_COUNTRIES.has(quote.country) || !pickerGroups().some((g) => g.options.some((o) => o.code === quote.country))) ? (
            <option value={quote.country}>{countryName(quote.country)}</option>
          ) : null}
          {pickerGroups().map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map(({code, name}) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </optgroup>
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
function UsDutyEstimate({
  country,
  subtotal,
  total,
}: {
  country: string | null;
  subtotal: number;
  /** Subtotal plus shipping, for the cost-at-your-door line. */
  total?: number | null;
}) {
  const quote = shippingQuote(country);
  if (!quote || quote.blocked || quote.duty !== 'us' || !(subtotal > 0)) return null;
  return (
    <>
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
    {total ? (
      <p className="cart-summary-note cart-landed-cost">
        {t('note_us_landed', 'Expected cost at your door: about {low} to {high} (total plus estimated duty).', {
          low: formatPrice(Math.round(total + subtotal * US_DUTY_LOW), 'EUR'),
          high: formatPrice(Math.round(total + subtotal * US_DUTY_HIGH), 'EUR'),
        })}
      </p>
    ) : null}
    </>
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
        'note_export_same_price',
        "Everyone pays the same euro price. Outside the EU no EU VAT is added; your country's import duty and taxes are paid to the carrier on delivery.",
      )}
    </p>
  );
  // The currency sentence sits next to the total, above Checkout.
  const currencyNote = null;
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
  // The funding-target condition, once for the whole cart instead of on
  // every line.
  const targetTerms =
    cart.lines.map((line) => fundingTargetTerms(line.shipPromise)).find(Boolean) ?? null;
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
  // Inside the EU the flat rate and the VAT-inclusive price are the whole
  // bill, so the total is a total. Outside it duties follow on delivery.
  const inEu = quote && !quote.blocked && quote.duty === 'none';
  const totalLabel = inEu
    ? t('register_total_final', 'Total')
    : t('register_estimated_total', 'Estimated total');
  const subtotalNum = Number(cart.subtotal.amount);
  const dutyHint =
    quote && !quote.blocked && quote.duty === 'us' && subtotalNum > 0
      ? t('sticky_duty_us', '+ about {low} to {high} import duty on delivery', {
          low: formatPrice(subtotalNum * US_DUTY_LOW, 'EUR'),
          high: formatPrice(subtotalNum * US_DUTY_HIGH, 'EUR'),
        })
      : quote && !quote.blocked && quote.duty === 'intl'
        ? t('sticky_duty_intl', '+ import duties on delivery')
        : null;
  // Cart lines in the order the build guide lists the parts, grouped by
  // when they ship: the paid batch first, then the funding targets.
  const sortedLines = sortCartLines(cart.lines);
  const lineGroups = groupCartLines(sortedLines);
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
          {lineGroups.map((group) => (
            <section className="cart-line-group" key={group.key}>
              {lineGroups.length > 1 ? <h2 className="cart-line-group-title">{group.title}</h2> : null}
              <ul className="cart-lines-scroll" aria-label={copyText('cart.sr_line_items') ?? 'Line items'}>
                {group.lines.map((line) => (
                  <CartLine key={line.id} line={line} info={info[line.id]} pending={pending} />
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="cart-summary-page" aria-busy={pending || undefined}>
          <dl className="cart-register">
            <div className="cart-register-row">
              <Txt id="cart.register_subtotal" as="dt" />
              <dd style={pendingStyle}>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</dd>
            </div>
            <ShippingRow country={country} onCountry={onCountry} />
            {estimatedTotal ? (
              <div className="cart-register-row cart-register-total">
                <dt>
                  <strong>{totalLabel}</strong>
                  <small>
                    {inEu
                      ? t('register_incl_vat', 'incl. VAT')
                      : t('register_duties_after', 'import duties on delivery not included')}
                  </small>
                </dt>
                <dd style={pendingStyle}>
                  <strong>{formatPrice(estimatedTotal.amount, estimatedTotal.currencyCode)}</strong>
                </dd>
              </div>
            ) : null}
          </dl>
          {quote && !quote.blocked && paysInOtherCurrency(quote.country) ? (
            <p className="cart-summary-note cart-currency-note">
              {t('note_currency', 'Prices are in euro. Your card issuer converts at its own rate.')}
            </p>
          ) : null}
          <UsDutyEstimate
            country={country}
            subtotal={Number(cart.subtotal.amount)}
            total={estimatedTotal ? estimatedTotal.amount : null}
          />
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
              targetTerms={targetTerms}
              outsideEu={Boolean(quote && !quote.blocked && quote.duty !== 'none')}
              onSplit={onSplit}
            />
          ) : targetTerms ? (
            <p className="cart-summary-note cart-target-terms">{targetTerms}</p>
          ) : null}
          {targetTerms ? <Txt id="collections-all.help_gift" as="p" className="cart-summary-note cart-gift-note" /> : null}
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
                {totalLabel}{' '}
                <strong style={pendingStyle}>{formatPrice(estimatedTotal.amount, estimatedTotal.currencyCode)}</strong>
                {dutyHint ? <small className="cart-sticky-duty">{dutyHint}</small> : null}
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
  targetTerms,
  outsideEu,
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  /** Outside the EU a second parcel can also mean a second carrier fee. */
  outsideEu: boolean;
  plan: {keep: string[]; later: string[]} | null;
  targetsOnly: boolean;
  /** The cart is one whole build: nothing flies before its last part, so
   *  the box says so in one line and the split becomes a quiet link. */
  completeBuild: boolean;
  /** The full funding-target condition, stated once. */
  targetTerms: string | null;
  onSplit: (items: Removed) => void;
}) {
  const revalidator = useRevalidator();
  const onPending = useContext(PendingContext);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const names = (ids: string[]) =>
    joinNames(cart.lines.filter((l) => ids.includes(l.id)).map(lineName));
  const laterCount = plan
    ? cart.lines.filter((l) => plan.later.includes(l.id)).length
    : 0;

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
        {targetTerms ? <p>{targetTerms}</p> : null}
        {plan
          ? splitForm(
              outsideEu
                ? t('split_early_link_export', 'Get the {keep} sooner (pays shipping, and any carrier customs fee, twice)', {keep: names(plan.keep)})
                : t('split_early_link', 'Get the {keep} sooner (pays shipping twice)', {keep: names(plan.keep)}),
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
        {sortCartLines(cart.lines).map((line) => {
          const target = info[line.id]?.target;
          return (
            <li key={line.id}>
              <strong>{lineName(line)}</strong>:{' '}
              {shortShipPromise(line.shipPromise)?.text ?? copyText('cart.mixed_in_stock') ?? 'in stock'}
              {target ? (
                <small className="cart-mixed-target">
                  {target.ordered > 0
                    ? t('mixed_target_count', '{ordered} of {units} ordered toward its funding target', {
                        ordered: target.ordered,
                        units: target.units,
                      })
                    : t('mixed_target_units', 'Funding target: {units} units', {units: target.units})}
                </small>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Txt id={targetsOnly ? 'cart.mixed_targets_body' : 'cart.mixed_body'} as="p" />
      {targetTerms && !targetsOnly ? <p>{targetTerms}</p> : null}
      {plan ? (
        <>
          <p>
            {t(
              laterCount > 1 ? 'mixed_split_plural' : 'mixed_split_single',
              laterCount > 1
                ? 'To get {keep} sooner, split this into two orders: we set {later} aside, you check out the rest, then add them back as a second order. Each order pays its own shipping.'
                : 'To get {keep} sooner, split this into two orders: we set {later} aside, you check out the rest, then add it back as a second order. Each order pays its own shipping.',
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
          <ShipChip promise={line.shipPromise} />
          {max !== null && line.quantity > max ? (
            <small className="cart-line-error" role="alert">{paidBatchMessage(max, line.shipPromise)}</small>
          ) : max !== null && max < MAX_LINE_QUANTITY ? (
            <small>{t('paid_left', '{left} left in the paid batch', {left: max})}</small>
          ) : null}
        </div>
        <div className="cart-sheet-qty">
          <LineQuantity
            line={line}
            name={lineName(line)}
            max={max === null ? MAX_LINE_QUANTITY : Math.min(MAX_LINE_QUANTITY, max)}
          />
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
function LineQuantity({line, name, max}: {line: ShopifyCartLine; name: string; max: number}) {
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

  // Sold singly, used in sets (4 motors per quad): offer the rest of the set.
  const set = setSize(line.handle);
  const toSet = set && quantity % set !== 0 ? set - (quantity % set) : 0;
  const completeSet = () => {
    const next = quantity + toSet;
    if (next > max) return;
    setQuantity(next);
    begin();
    window.clearTimeout(timer.current);
    void send([['intent', 'update'], ['lineId', line.id], ['quantity', String(next)]]);
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
        <button
          type="submit"
          className="cart-line-remove"
          disabled={busy}
          aria-label={t('line_remove_named', 'Remove {name}', {name})}
          title={t('line_remove_named', 'Remove {name}', {name})}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
        </button>
      </Form>
      {toSet && quantity + toSet <= max ? (
        <p className="cart-line-set">
          {t('line_set_hint', 'A quad needs {set} motors.', {set: set ?? 4})}{' '}
          <button type="button" className="text-link" disabled={busy} onClick={completeSet}>
            {t('line_set_add', '+ Add {count} more', {count: toSet})}
          </button>
        </p>
      ) : null}
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
