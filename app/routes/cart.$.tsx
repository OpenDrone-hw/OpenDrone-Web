import {Form, Link, redirect, useLoaderData, useRouteLoaderData} from 'react-router';
import type {Route} from './+types/cart.$';
import {getCart, type ShopifyCart, type ShopifyCartLine} from '~/lib/shopify-storefront';
import {checkoutOpen, loadSessionCart} from '~/lib/shopify-cart-action';
import {formatPrice} from '~/lib/catalog';
import {Txt} from '~/components/Txt';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {priceNote} from '~/lib/visitor-country';
import type {RootLoader} from '~/root';

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
  return {cart};
}

export default function CartPage() {
  const {cart} = useLoaderData<typeof loader>();
  return (
    <main className="cart page-shell">
      <header className="page-header">
        <p className="page-eyebrow"><Txt id="cart.eyebrow" /></p>
        <h1 className="page-title"><Txt id="cart.title" /></h1>
        <p className="page-description"><Txt id="cart.description" /></p>
      </header>
      {cart?.lines.length ? <PopulatedCart cart={cart} /> : <EmptyCart />}
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

function PopulatedCart({cart}: {cart: ShopifyCart}) {
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
          </div>
        ) : null}
        {hasPreorder ? <Txt id="cart.note_preorder" as="p" className="cart-summary-note" /> : null}
        <Txt id={`cart.note_${note}`} as="p" className="cart-summary-note" />
        <Form method="post" action="/api/shopify/cart">
          <input type="hidden" name="intent" value="checkout" />
          <button className="cart-checkout-cta" type="submit"><Txt id="cart.checkout_cta" /></button>
        </Form>
        <div className="cart-secondary-actions">
          <Link className="cart-keep-shopping" to="/products"><Txt id="cart.keep_shopping" /></Link>
        </div>
        <Txt id="cart.note_terms" as="p" className="cart-summary-note" />
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
          <img src={line.image.url} alt={line.image.altText ?? line.title} width={56} height={56} />
        ) : (
          <span className="cart-line-noimage" aria-hidden="true" />
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
          <div className="cart-line-quantity cart-line-quantity--sheet">
            <div className="cart-sheet-stepper">
              <LineForm line={line} quantity={line.quantity - 1} disabled={line.quantity <= 1} label={copyText('cart.line_decrease_aria') ?? 'Decrease quantity'}>−</LineForm>
              <span className="cart-sheet-qty-value" aria-live="polite">{line.quantity}</span>
              <LineForm line={line} quantity={line.quantity + 1} disabled={line.quantity >= 50} label={copyText('cart.line_increase_aria') ?? 'Increase quantity'}>+</LineForm>
            </div>
            <Form method="post" action="/api/shopify/cart">
              <input type="hidden" name="intent" value="remove" />
              <input type="hidden" name="lineId" value={line.id} />
              <button type="submit"><Txt id="cart.line_remove" /></button>
            </Form>
          </div>
        </div>
        <div className="cart-sheet-total">{formatPrice(line.total.amount, line.total.currencyCode)}</div>
      </div>
    </li>
  );
}

function LineForm({line, quantity, disabled, label, children}: {line: ShopifyCartLine; quantity: number; disabled?: boolean; label: string; children: React.ReactNode}) {
  return (
    <Form method="post" action="/api/shopify/cart">
      <input type="hidden" name="intent" value="update" />
      <input type="hidden" name="lineId" value={line.id} />
      <input type="hidden" name="quantity" value={quantity} />
      <button type="submit" disabled={disabled} aria-label={label}>{children}</button>
    </Form>
  );
}
