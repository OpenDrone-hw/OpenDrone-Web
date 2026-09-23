import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {Form, Link, redirect, useLoaderData, useRevalidator, useRouteLoaderData} from 'react-router';
import {shopifyImageUrl} from '~/lib/shopify-image';
import type {Route} from './+types/cart.$';
import {fetchPaymentMethods, getCart, type ShopifyCart, type ShopifyCartLine} from '~/lib/shopify-storefront';
import {
  CART_CHECK,
  DATES_SEEN_FIELD,
  cartLineInfo,
  checkoutOpen,
  loadSessionCart,
  splitPlan,
  variantLink,
  type CartLineInfo,
} from '~/lib/shopify-cart-action';
import {formatPrice} from '~/lib/catalog';
import {parseBuilds} from '~/lib/build-recommendations';
import buildsJson from '../../content/builds.json';
import {lineDisplayName, setSize} from '~/lib/product-content';
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

/**
 * The cart: every line with its quantity, total and ship chip, then the
 * subtotal, shipping to the picked country, the total and Checkout. While
 * the store is closed, /cart and the old /cart/<variant>:<qty> permalinks
 * go to the product listing.
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
  let payments: string[] = [];
  if (cart?.lines.length) {
    try {
      payments = await fetchPaymentMethods(context.env);
    } catch (error) {
      console.error('[shopify-cart] payment settings read failed', error instanceof Error ? error.message : 'unknown error');
    }
  }
  return {cart, info, check, payments};
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

/** The one-line notice for a checkout the server sent back to the cart. */
function checkNotice(check: string | null): string | null {
  if (check === CART_CHECK.paidBatch) return t('check_paid_batch', 'Not enough left in batch 1. Lower the quantity where shown.');
  if (check === CART_CHECK.shipDate) return t('check_ship_date', 'A ship date changed. Check the dates below.');
  if (check === CART_CHECK.mixedDates) return t('check_mixed_dates', 'Items ship on different dates. Check the dates below.');
  return null;
}

export default function CartPage() {
  const {cart, info, check, payments} = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData<RootLoader>('root');
  // Lines moved out for a second order: kept in this browser so the list
  // survives a reload and the trip through checkout.
  const [removed, setRemoved] = useState<Removed>([]);
  // The destination the shipping row quotes: the visitor's country, else
  // Belgium, until the buyer picks another one. Never empty, so shipping
  // and the total always show before Checkout.
  const [country, setCountry] = useState<string | null>(rootData?.visitorCountry ?? 'BE');
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
  const notice = checkNotice(check);
  return (
    <div className="cart page-shell">
      <header className="page-header">
        <h1 className="page-title"><Txt id="cart.title" /></h1>
      </header>
      {notice ? <p className="cart-alert" role="alert">{notice}</p> : null}
      {removed.length ? (
        <SplitReminder items={removed} cartHasLines={Boolean(cart?.lines.length)} onChange={updateRemoved} />
      ) : null}
      {cart?.lines.length ? (
        <PopulatedCart
          cart={cart}
          info={info}
          payments={payments}
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
 * The lines taken out for a second order. While this order is still in the
 * cart, each links to its product page; once the cart is empty (the first
 * order is checked out), one button adds the same quantities back.
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
    <div className="cart-split-reminder" role="status">
      <p>
        <strong>{t('split_title', 'Second order:')}</strong>{' '}
        {items.map((item, i) => (
          <span key={item.id}>
            {i ? ', ' : null}
            <Link to={item.href}>{t('split_item', '{quantity}x {name}', {quantity: item.quantity, name: item.name})}</Link>
          </span>
        ))}
      </p>
      <p className="cart-split-actions">
        {addable.length ? (
          <button type="button" className="cart-split-link" disabled={busy} onClick={() => void addBack()}>
            {busy ? t('split_adding', 'Adding…') : t('split_add_back', 'Add to cart')}
          </button>
        ) : null}
        <button type="button" className="cart-split-link" disabled={busy} onClick={() => onChange([])}>
          {t('split_dismiss', 'Clear')}
        </button>
      </p>
      {error ? <small className="cart-line-error" role="alert">{error}</small> : null}
    </div>
  );
}

function EmptyCart() {
  return (
    <section className="cart-empty">
      <h2 className="cart-empty-title"><Txt id="cart.empty_title" /></h2>
      <Link className="cart-empty-link" to="/products" prefetch="intent"><Txt id="cart.empty_cta" /></Link>
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

/** "Shipping to [country]" with the flat rate to it. */
function ShippingRow({country, onCountry}: {country: string | null; onCountry: (code: string) => void}) {
  const quote = shippingQuote(country);
  return (
    <div className="cart-register-row cart-ship-row">
      <dt>
        <label htmlFor="cart-ship-country">{t('shipping_label_ship_to', 'Shipping to')}</label>
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

function PopulatedCart({
  cart,
  info,
  payments,
  country,
  onCountry,
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  payments: string[];
  country: string | null;
  onCountry: (code: string) => void;
  onSplit: (items: Removed) => void;
}) {
  const revalidator = useRevalidator();
  const [inFlight, setInFlight] = useState(0);
  const onPending = useCallback((delta: number) => setInFlight((n) => Math.max(0, n + delta)), []);
  const pending = inFlight > 0 || revalidator.state !== 'idle';

  // One parcel per order: when lines ship at different times, the early
  // ones wait for the last. Lines waiting for different funding targets do
  // not ship together even when their promise reads the same.
  const groupOf = (line: ShopifyCartLine) => info[line.id]?.group ?? `date:${line.shipPromise ?? ''}`;
  const mixed = new Set(cart.lines.map(groupOf)).size > 1;
  const quote = shippingQuote(country);
  const shipBlocked = quote?.blocked === true;
  // Subtotal plus the flat rate for the picked country; checkout confirms it.
  const total =
    quote && !quote.blocked
      ? {amount: Number(cart.subtotal.amount) + quote.rate, currencyCode: cart.subtotal.currencyCode}
      : null;
  // Outside the EU the total reads plain "Total" and the carrier collects
  // duties.
  const outsideEu = Boolean(quote && !quote.blocked && quote.duty !== 'none');
  const overLimit = cart.lines.some((line) => {
    const max = info[line.id]?.maxQuantity;
    return max != null && line.quantity > max;
  });
  const blocked = pending || overLimit;
  const pendingStyle = pending ? {opacity: 0.5} : undefined;

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
            {sortCartLines(cart.lines).map((line) => (
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
            <div className="cart-register-row is-total">
              <dt>{outsideEu ? t('register_total', 'Total') : t('register_total_vat', 'Total (incl. VAT)')}</dt>
              <dd style={pendingStyle}>
                {total
                  ? formatPrice(total.amount, total.currencyCode)
                  : t('total_plus_shipping', '{subtotal} + shipping', {
                      subtotal: formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode),
                    })}
              </dd>
            </div>
          </dl>
          {outsideEu ? <p className="cart-summary-note">{t('note_duties', 'Import duties paid on delivery.')}</p> : null}
          {mixed ? <MixedNote cart={cart} info={info} onSplit={onSplit} /> : null}
          {shipBlocked ? (
            <p className="cart-summary-note" role="note">
              {t('checkout_blocked', 'Not available in {country}.', {country: countryName(quote?.country ?? '')})}{' '}
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
              {/* This page shows the one-parcel line, so checkout may go on. */}
              {mixed ? <input type="hidden" name={DATES_SEEN_FIELD} value="1" /> : null}
              <button className="cart-checkout-cta" type="submit" disabled={blocked} aria-disabled={blocked || undefined}>
                {pending ? t('checkout_updating', 'Updating cart…') : <Txt id="cart.checkout_cta" />}
              </button>
            </Form>
          )}
          <PaymentMarks methods={payments} />
          <Txt id="cart.note_terms" as="p" className="cart-summary-note cart-terms" />
        </div>
      </section>
    </PendingContext.Provider>
  );
}

/** Shopify's names for the marks, as a buyer knows them. */
const PAYMENT_NAMES: Record<string, string> = {
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  AMERICAN_EXPRESS: 'Amex',
  DISCOVER: 'Discover',
  DINERS_CLUB: 'Diners',
  JCB: 'JCB',
  APPLE_PAY: 'Apple Pay',
  GOOGLE_PAY: 'Google Pay',
  SHOPIFY_PAY: 'Shop Pay',
  ANDROID_PAY: 'Google Pay',
};

/** One muted row of the payment methods checkout accepts, from the shop's
 *  payment settings. Nothing when Shopify reports none. */
function PaymentMarks({methods}: {methods: string[]}) {
  const names = [...new Set(methods.map((m) => PAYMENT_NAMES[m]).filter(Boolean))];
  if (!names.length) return null;
  return (
    <ul className="cart-payments" aria-label={t('payments_aria', 'Payment methods')}>
      {names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
}

/**
 * Lines that ship at different times go in one parcel when the last is
 * ready. When some lines have a date of their own, a quiet link takes the
 * rest out of this order so they can be ordered separately.
 */
function MixedNote({
  cart,
  info,
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  onSplit: (items: Removed) => void;
}) {
  const revalidator = useRevalidator();
  const onPending = useContext(PendingContext);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const plan = splitPlan(cart, info);

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

  return (
    <div className="cart-mixed-note" role="note">
      <div className="cart-summary-note cart-mixed-line">
        {t('mixed_one_parcel', 'One parcel, ships with the last item')}
        {plan ? (
          <>
            {' · '}
            <Form
              method="post"
              action="/api/shopify/cart"
              onSubmit={(event) => void split(event)}
              className="cart-split-form"
            >
              <input type="hidden" name="intent" value="remove" />
              {plan.later.map((id) => <input key={id} type="hidden" name="lineId" value={id} />)}
              <button type="submit" className="cart-split-link" disabled={busy}>
                {busy ? t('split_busy', 'Removing…') : t('split_link', 'Split order')}
              </button>
            </Form>
          </>
        ) : null}
      </div>
      {failed ? (
        <small className="cart-line-error" role="alert">
          {copyText('cart.line_update_failed') ?? 'Could not update. Try again.'}
        </small>
      ) : null}
    </div>
  );
}

function CartLine({line, info, pending}: {line: ShopifyCartLine; info: CartLineInfo | undefined; pending: boolean}) {
  const max = info?.maxQuantity ?? null;
  // A funding-target line reads "ETA ... if funded" until its target is met.
  const target = info?.target;
  const ifFunded = !target || target.ordered < target.units;
  return (
    <li className="cart-line cart-line--sheet">
      <div className="cart-sheet-row">
        {line.image ? (
          <img src={shopifyImageUrl(line.image.url, 112)} alt={line.image.altText ?? line.title} width={56} height={56} />
        ) : (
          <span className="cart-line-noimage" aria-hidden="true">{line.title.slice(4, 5) || line.title[0]}</span>
        )}
        <div className="cart-sheet-item">
          <Link to={variantLink(line.handle, line.selectedOptions)}><strong>{lineName(line)}</strong></Link>
          <ShipChip promise={line.shipPromise} ifFunded={ifFunded} />
          {max !== null && line.quantity > max ? (
            <small className="cart-line-error" role="alert">{t('line_over_batch', 'Only {left} left in batch 1.', {left: max})}</small>
          ) : max !== null && max < MAX_LINE_QUANTITY && line.quantity >= max ? (
            <small>{t('paid_left', '{left} left in batch 1', {left: max})}</small>
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
        <button type="button" className="cart-line-set text-link" disabled={busy} onClick={completeSet}>
          {t('line_set_add', '+ {count} for a set of {set}', {count: toSet, set: set ?? 4})}
        </button>
      ) : null}
      {error ? (
        <small className="cart-line-error" role="alert">{error}</small>
      ) : quantity >= max && max >= MAX_LINE_QUANTITY ? (
        <small className="cart-line-max">
          {t('line_max', 'Max {count} per order', {count: MAX_LINE_QUANTITY})}
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
