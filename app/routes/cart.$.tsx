import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {Form, Link, redirect, useLoaderData, useRevalidator, useRouteLoaderData} from 'react-router';
import {shopifyImageUrl} from '~/lib/shopify-image';
import type {Route} from './+types/cart.$';
import {getCart, type ShopifyCart, type ShopifyCartLine} from '~/lib/shopify-storefront';
import {
  CART_CHECK,
  cartLineInfo,
  checkoutOpen,
  loadSessionCart,
  paidBatchMessage,
  splitPlan,
  variantLink,
  type CartLineInfo,
} from '~/lib/shopify-cart-action';
import {formatPrice} from '~/lib/catalog';
import {Txt} from '~/components/Txt';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {countryName, shippingQuote} from '~/lib/shipping-rates';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import type {RootLoader} from '~/root';
import {CartAddError, postCart} from '~/lib/cart-client';

const CART_KEY = 'shopifyCartId';
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

type Removed = Array<{id: string; name: string; href: string}>;

export default function CartPage() {
  const {cart, info, check} = useLoaderData<typeof loader>();
  // Lines moved out for a second order: kept here so the links survive the
  // cart reloading without them.
  const [removed, setRemoved] = useState<Removed>([]);
  return (
    <main className="cart page-shell">
      <header className="page-header">
        <p className="page-eyebrow"><Txt id="cart.eyebrow" /></p>
        <h1 className="page-title"><Txt id="cart.title" /></h1>
        <p className="page-description"><Txt id="cart.description" /></p>
      </header>
      {check === CART_CHECK.paidBatch || check === CART_CHECK.shipDate ? (
        <p className="cart-mixed-warning" role="alert">
          {check === CART_CHECK.paidBatch
            ? t('check_paid_batch', 'An item in your cart has more units than its paid batch has left. Lower the quantity where shown, then check out.')
            : t('check_ship_date', 'A ship date in your cart changed since you added the item. Check the dates below, then check out.')}
        </p>
      ) : null}
      {removed.length ? (
        <div className="cart-mixed-warning" role="status">
          <p>{t('split_removed', 'Removed for a second order. Add them again after this checkout:')}</p>
          <ul>
            {removed.map((item) => (
              <li key={item.id}><Link to={item.href}>{item.name}</Link></li>
            ))}
          </ul>
        </div>
      ) : null}
      {cart?.lines.length ? (
        <PopulatedCart cart={cart} info={info} onSplit={(items) => setRemoved(items)} />
      ) : (
        <EmptyCart />
      )}
    </main>
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
  return line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.title} ${line.variantTitle}`
    : line.title;
}

/** Quantity changes in flight anywhere in the cart: totals are stale and
 *  checkout waits until Shopify has confirmed them. */
const PendingContext = createContext<(delta: number) => void>(() => {});

function ShippingRow({country}: {country: string | null}) {
  const quote = shippingQuote(country);
  if (!quote) {
    return (
      <div className="cart-register-row">
        <dt>{t('shipping_label', 'Shipping')}</dt>
        <dd>{t('shipping_at_checkout', 'at checkout')}</dd>
      </div>
    );
  }
  const name = countryName(quote.country);
  return (
    <div className="cart-register-row">
      <dt>{t('shipping_to', 'Shipping to {country}', {country: name})}</dt>
      <dd>
        {quote.blocked
          ? t('shipping_blocked', 'not available')
          : t('shipping_from', 'from {price}', {price: formatPrice(quote.rate, 'EUR')})}
      </dd>
    </div>
  );
}

/** Who pays import duties, by visitor country: never collected at
 *  checkout; outside the EU the carrier collects them on delivery. */
function DutyNote({country}: {country: string | null}) {
  const quote = shippingQuote(country);
  const duty = quote && !quote.blocked ? quote.duty : 'none';
  if (duty === 'us') return <Txt id="cart.note_us" as="p" className="cart-summary-note" />;
  if (duty === 'intl') return <Txt id="cart.note_intl" as="p" className="cart-summary-note" />;
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
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  onSplit: (items: Removed) => void;
}) {
  const rootData = useRouteLoaderData<RootLoader>('root');
  const country = rootData?.visitorCountry ?? null;
  const revalidator = useRevalidator();
  const [inFlight, setInFlight] = useState(0);
  const onPending = useCallback((delta: number) => setInFlight((n) => Math.max(0, n + delta)), []);
  const pending = inFlight > 0 || revalidator.state !== 'idle';

  const hasPreorder = cart.lines.some((line) => line.shipPromise);
  // One parcel per order: when lines ship at different times, the early
  // ones wait for the last. Lines waiting for different funding targets do
  // not ship together even when their promise reads the same.
  const groupOf = (line: ShopifyCartLine) => info[line.id]?.group ?? `date:${line.shipPromise ?? ''}`;
  const mixed = new Set(cart.lines.map(groupOf)).size > 1;
  const plan = mixed ? splitPlan(cart, info) : null;
  const overLimit = cart.lines.some((line) => {
    const max = info[line.id]?.maxQuantity;
    return max != null && line.quantity > max;
  });
  const blocked = pending || overLimit;
  const pendingStyle = pending ? {opacity: 0.5} : undefined;

  const checkoutForm = (className: string) => (
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
            <ShippingRow country={country} />
          </dl>
          {mixed ? (
            <MixedWarning cart={cart} info={info} plan={plan} onSplit={onSplit} />
          ) : null}
          {hasPreorder && !mixed ? <Txt id="cart.note_preorder" as="p" className="cart-summary-note" /> : null}
          <DutyNote country={country} />
          {checkoutForm('cart-checkout-cta')}
          <div className="cart-secondary-actions">
            <Link className="cart-keep-shopping" to="/products"><Txt id="cart.keep_shopping" /></Link>
          </div>
          <Txt id="cart.note_terms" as="p" className="cart-summary-note" />
        </div>
        {/* Phones: the summary sits below every line, so the total and the
            checkout button also ride along the bottom of the screen. */}
        <div className="cart-sticky-bar">
          <span>
            <Txt id="cart.register_subtotal" />{' '}
            <strong style={pendingStyle}>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</strong>
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
  onSplit,
}: {
  cart: ShopifyCart;
  info: Record<string, CartLineInfo>;
  plan: {keep: string[]; later: string[]} | null;
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
          .map((l) => ({id: l.id, name: lineName(l), href: variantLink(l.handle, l.selectedOptions)})),
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
    <div className="cart-mixed-warning" role="note">
      <Txt id="cart.mixed_title" as="p" />
      <ul>
        {cart.lines.map((line) => {
          const target = info[line.id]?.target;
          return (
            <li key={line.id}>
              {lineName(line)}: {line.shipPromise ?? copyText('cart.mixed_in_stock') ?? 'in stock'}
              {target
                ? ` ${t('mixed_target', '(its target: {ordered} of {units} ordered)', {
                    ordered: target.ordered,
                    units: target.units,
                  })}`
                : null}
            </li>
          );
        })}
      </ul>
      <Txt id="cart.mixed_body" as="p" />
      {plan ? (
        <>
          <p>
            {t(
              'mixed_split',
              'Want {keep} sooner? Order {later} separately: remove it here, check out, then order it in a second order. Each order ships on its own and has its own shipping charge.',
              {keep: names(plan.keep), later: names(plan.later)},
            )}
          </p>
          <Form method="post" action="/api/shopify/cart" onSubmit={(event) => void split(event)}>
            <input type="hidden" name="intent" value="remove" />
            {plan.later.map((id) => <input key={id} type="hidden" name="lineId" value={id} />)}
            <button type="submit" className="cart-keep-shopping" disabled={busy}>
              {busy ? t('split_busy', 'Removing…') : t('split_cta', 'Order the rest separately')}
            </button>
          </Form>
          {failed ? (
            <small className="cart-line-error" role="alert">
              {copyText('cart.line_update_failed') ?? 'Could not update. Try again.'}
            </small>
          ) : null}
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
          {options.map(({name, value}) => <small key={name}>{name}: {value}</small>)}
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
      {error ? <small className="cart-line-error" role="alert">{error}</small> : null}
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
