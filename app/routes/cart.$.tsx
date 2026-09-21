import {useEffect, useRef, useState} from 'react';
import {Form, Link, redirect, useLoaderData, useRevalidator, useRouteLoaderData} from 'react-router';
import {shopifyImageUrl} from '~/lib/shopify-image';
import type {Route} from './+types/cart.$';
import {getCart, type ShopifyCart, type ShopifyCartLine} from '~/lib/shopify-storefront';
import {checkoutOpen, earlyLineIds, loadSessionCart} from '~/lib/shopify-cart-action';
import {formatPrice} from '~/lib/catalog';
import {Txt} from '~/components/Txt';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {priceNote} from '~/lib/visitor-country';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import type {RootLoader} from '~/root';
import {postCart} from '~/lib/cart-client';

const CART_KEY = 'shopifyCartId';

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

export async function loader({context, params}: Route.LoaderArgs) {
  if (!checkoutOpen(context.env) || params['*']) throw redirect('/products', 301);
  const cart = await loadSessionCart(context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    logError: (message) => console.error('[shopify-cart] cart read failed', message),
  });
  // Lines that could go out first as their own order (see the split button).
  const catalog = cart?.lines.length ? await context.catalog.get().catch(() => null) : null;
  const splitIds = cart && catalog ? earlyLineIds(catalog, cart, context.env) : [];
  return {cart, splitIds};
}

export default function CartPage() {
  const {cart, splitIds} = useLoaderData<typeof loader>();
  return (
    <main className="cart page-shell">
      <header className="page-header">
        <p className="page-eyebrow"><Txt id="cart.eyebrow" /></p>
        <h1 className="page-title"><Txt id="cart.title" /></h1>
        <p className="page-description"><Txt id="cart.description" /></p>
      </header>
      {cart?.lines.length ? <PopulatedCart cart={cart} splitIds={splitIds} /> : <EmptyCart />}
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

/** In stock, or the preorder ship promise: what decides when a line ships. */
function shipKey(line: ShopifyCartLine): string {
  return line.shipPromise ?? '';
}

function lineName(line: ShopifyCartLine): string {
  return line.variantTitle && line.variantTitle !== 'Default Title'
    ? `${line.title} ${line.variantTitle}`
    : line.title;
}

function PopulatedCart({cart, splitIds}: {cart: ShopifyCart; splitIds: string[]}) {
  const rootData = useRouteLoaderData<RootLoader>('root');
  const note = priceNote(rootData?.visitorCountry ?? null);
  const hasPreorder = cart.lines.some((line) => line.shipPromise);
  // One parcel per order: when lines ship on different dates, the early
  // ones wait for the last. Say so, by name, before checkout.
  const mixed = new Set(cart.lines.map(shipKey)).size > 1;
  return (
    <section className="cart-main">
      <div className="cart-details">
        <div className="cart-sheet-head" aria-hidden="true">
          <Txt id="cart.sheet_head_item" className="cart-sheet-head-item" />
          <Txt id="cart.sheet_head_qty" className="cart-sheet-head-qty" />
          <Txt id="cart.sheet_head_total" className="cart-sheet-head-total" />
        </div>
        <ul className="cart-lines-scroll" aria-label={copyText('cart.sr_line_items') ?? 'Line items'}>
          {cart.lines.map((line) => <CartLine key={line.id} line={line} />)}
        </ul>
      </div>
      <div className="cart-summary-page">
        <dl className="cart-register">
          <div className="cart-register-row">
            <Txt id="cart.register_subtotal" as="dt" />
            <dd>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</dd>
          </div>
        </dl>
        {mixed ? (
          <div className="cart-mixed-warning" role="note">
            <Txt id="cart.mixed_title" as="p" />
            <ul>
              {cart.lines.map((line) => (
                <li key={line.id}>
                  {lineName(line)}: {line.shipPromise ?? copyText('cart.mixed_in_stock') ?? 'in stock'}
                </li>
              ))}
            </ul>
            <Txt id="cart.mixed_body" as="p" />
            {splitIds.length ? (
              <Form method="post" action="/api/shopify/cart">
                <input type="hidden" name="intent" value="checkout" />
                <input type="hidden" name="split" value="early" />
                <button className="cart-split-cta" type="submit">
                  {(copyText('cart.split_cta') ?? 'Check out {items} now').replace(
                    '{items}',
                    cart.lines.filter((l) => splitIds.includes(l.id)).map(lineName).join(', '),
                  )}
                </button>
                <Txt id="cart.split_note" as="p" className="cart-summary-note" />
              </Form>
            ) : null}
          </div>
        ) : null}
        {hasPreorder && !mixed ? <Txt id="cart.note_preorder" as="p" className="cart-summary-note" /> : null}
        <Txt id={`cart.note_${note}`} as="p" className="cart-summary-note" />
        <Form
          method="post"
          action="/api/shopify/cart"
          onSubmit={() =>
            trackCheckoutClick({currency: cart.subtotal.currencyCode, amount: Number(cart.subtotal.amount)})
          }
        >
          <input type="hidden" name="intent" value="checkout" />
          <button className="cart-checkout-cta" type="submit"><Txt id="cart.checkout_cta" /></button>
        </Form>
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
          <strong>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</strong>
        </span>
        <Form
          method="post"
          action="/api/shopify/cart"
          onSubmit={() =>
            trackCheckoutClick({currency: cart.subtotal.currencyCode, amount: Number(cart.subtotal.amount)})
          }
        >
          <input type="hidden" name="intent" value="checkout" />
          <button className="cart-sticky-checkout" type="submit"><Txt id="cart.checkout_cta" /></button>
        </Form>
      </div>
    </section>
  );
}

function CartLine({line}: {line: ShopifyCartLine}) {
  const options = line.selectedOptions.filter(
    ({name, value}) => !(name === 'Title' && value === 'Default Title'),
  );
  return (
    <li className="cart-line cart-line--sheet">
      <div className="cart-sheet-row">
        {line.image ? (
          <img src={shopifyImageUrl(line.image.url, 112)} alt={line.image.altText ?? line.title} width={56} height={56} />
        ) : (
          <span className="cart-line-noimage" aria-hidden="true">{line.title.slice(4, 5) || line.title[0]}</span>
        )}
        <div className="cart-sheet-item">
          <Link to={`/products/${line.handle}`}><strong>{line.title}</strong></Link>
          {options.map(({name, value}) => <small key={name}>{name}: {value}</small>)}
          {line.shipPromise ? (
            <small className="cart-line-preorder">
              {copyText('cart.preorder_line_prefix') ?? 'Pre-order'} · {line.shipPromise}
            </small>
          ) : null}
        </div>
        <div className="cart-sheet-qty">
          <LineQuantity line={line} />
        </div>
        <div className="cart-sheet-total">
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

const MAX_LINE_QUANTITY = 50;

/**
 * Quantity stepper. Clicks change the number at once and are sent together
 * a moment after the last one, so fast clicking never drops a step; the
 * control reports busy while Shopify confirms. Without JavaScript each
 * button is a plain form post that reloads /cart.
 */
function LineQuantity({line}: {line: ShopifyCartLine}) {
  const revalidator = useRevalidator();
  const [quantity, setQuantity] = useState(line.quantity);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(false);

  // Take the server value once nothing of ours is in flight.
  useEffect(() => {
    if (!pending.current) setQuantity(line.quantity);
  }, [line.quantity]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const send = async (fields: Array<[string, string]>) => {
    setBusy(true);
    setFailed(false);
    try {
      await postCart('/api/shopify/cart', fields);
    } catch {
      setFailed(true);
      setQuantity(line.quantity);
    } finally {
      pending.current = false;
      setBusy(false);
      void revalidator.revalidate();
    }
  };

  const step = (event: React.FormEvent<HTMLFormElement>, next: number) => {
    event.preventDefault();
    if (next < 1 || next > MAX_LINE_QUANTITY) return;
    setQuantity(next);
    pending.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void send([['intent', 'update'], ['lineId', line.id], ['quantity', String(next)]]);
    }, 400);
  };

  const remove = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    window.clearTimeout(timer.current);
    pending.current = true;
    void send([['intent', 'remove'], ['lineId', line.id]]);
  };

  return (
    <div className="cart-line-quantity cart-line-quantity--sheet" aria-busy={busy || undefined}>
      <div className="cart-sheet-stepper">
        <LineForm line={line} quantity={quantity - 1} disabled={quantity <= 1} onSubmit={(e) => step(e, quantity - 1)} label={copyText('cart.line_decrease_aria') ?? 'Decrease quantity'}>−</LineForm>
        <span className="cart-sheet-qty-value" aria-live="polite">{quantity}</span>
        <LineForm line={line} quantity={quantity + 1} disabled={quantity >= MAX_LINE_QUANTITY} onSubmit={(e) => step(e, quantity + 1)} label={copyText('cart.line_increase_aria') ?? 'Increase quantity'}>+</LineForm>
      </div>
      <Form method="post" action="/api/shopify/cart" onSubmit={remove}>
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="lineId" value={line.id} />
        <button type="submit" disabled={busy}><Txt id="cart.line_remove" /></button>
      </Form>
      {failed ? <small className="cart-line-error" role="alert">{copyText('cart.line_update_failed') ?? 'Could not update. Try again.'}</small> : null}
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
