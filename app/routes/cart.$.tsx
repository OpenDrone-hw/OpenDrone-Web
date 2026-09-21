import {Form, Link, useLoaderData} from 'react-router';
import type {Route} from './+types/cart.$';
import {getCart, type ShopifyCart, type ShopifyCartLine} from '~/lib/shopify-storefront';
import {handleShopifyCartLoader} from '~/lib/shopify-cart-action';
import {formatPrice} from '~/lib/catalog';
import {Txt} from '~/components/Txt';
import {buildSeoMeta} from '~/lib/seo';

const CART_KEY = 'shopifyCartId';

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({title: 'Cart', description: 'Review your OpenDrone cart.'});

export async function loader({context}: Route.LoaderArgs) {
  const response = await handleShopifyCartLoader(context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    logError: (message) => console.error('[shopify-cart] cart read failed', message),
  });
  const cart = (await response.json()) as ShopifyCart | null;
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
      {!cart?.lines.length ? <EmptyCart /> : <PopulatedCart cart={cart} />}
    </main>
  );
}

function EmptyCart() {
  return <section className="cart-empty"><h2 className="cart-empty-title"><Txt id="cart.empty_title" /></h2><Link className="hero-cta-primary" to="/products"><Txt id="cart.empty_cta" /></Link></section>;
}

function PopulatedCart({cart}: {cart: ShopifyCart}) {
  return (
    <section className="cart-main">
      <div className="cart-details">
        <div className="cart-sheet-head" aria-hidden="true"><Txt id="cart.sheet_head_item" className="cart-sheet-head-item" /><Txt id="cart.sheet_head_qty" className="cart-sheet-head-qty" /><Txt id="cart.sheet_head_total" className="cart-sheet-head-total" /></div>
        <ul className="cart-lines-scroll" aria-label="Line items">{cart.lines.map((line) => <CartLine key={line.id} line={line} />)}</ul>
      </div>
      <div className="cart-summary-page">
        <dl className="cart-register">
          <div className="cart-register-row"><Txt id="cart.register_subtotal" as="dt" /><dd>{formatPrice(cart.subtotal.amount, cart.subtotal.currencyCode)}</dd></div>
          <div className="cart-register-row is-total"><Txt id="cart.register_total" as="dt" /><dd>{formatPrice(cart.total.amount, cart.total.currencyCode)}</dd></div>
        </dl>
        <Txt id="cart.note_preorder" as="p" className="cart-summary-note" />
        <Txt id="cart.note_vat" as="p" className="cart-summary-note" />
        <Form method="post" action="/api/shopify/cart"><input type="hidden" name="intent" value="checkout" /><button className="cart-checkout-cta" type="submit"><Txt id="cart.checkout_cta" /></button></Form>
        <div className="cart-secondary-actions"><Link className="cart-keep-shopping" to="/products"><Txt id="cart.keep_shopping" /></Link></div>
        <Txt id="cart.note_terms" as="p" className="cart-summary-note" />
      </div>
    </section>
  );
}

function CartLine({line}: {line: ShopifyCartLine}) {
  const options = line.selectedOptions.filter(({name, value}) => !(name === 'Title' && value === 'Default Title'));
  return (
    <li className="cart-line cart-line--sheet"><div className="cart-sheet-row">
      {line.image ? <img src={line.image.url} alt={line.image.altText ?? line.title} width={56} height={56} /> : <span />}
      <div className="cart-sheet-item"><Link to={`/products/${line.handle}`}><strong>{line.title}</strong></Link>{options.map(({name, value}) => <small key={name}>{name}: {value}</small>)}</div>
      <div className="cart-sheet-qty"><div className="cart-line-quantity cart-line-quantity--sheet"><div className="cart-sheet-stepper"><LineForm line={line} quantity={line.quantity - 1} disabled={line.quantity <= 1} label="Decrease quantity">−</LineForm><span className="cart-sheet-qty-value" aria-live="polite">{line.quantity}</span><LineForm line={line} quantity={line.quantity + 1} label="Increase quantity">+</LineForm></div><Form method="post" action="/api/shopify/cart"><input type="hidden" name="intent" value="remove" />{line.lineIds.map((lineId) => <input key={lineId} type="hidden" name="lineId" value={lineId} />)}<button type="submit"><Txt id="cart.line_remove" /></button></Form></div></div>
      <div className="cart-sheet-total">{formatPrice(line.total.amount, line.total.currencyCode)}</div>
    </div></li>
  );
}

function LineForm({line, quantity, disabled, label, children}: {line: ShopifyCartLine; quantity: number; disabled?: boolean; label: string; children: React.ReactNode}) {
  return <Form method="post" action="/api/shopify/cart"><input type="hidden" name="intent" value="update" />{line.lineIds.map((lineId) => <input key={lineId} type="hidden" name="lineId" value={lineId} />)}<input type="hidden" name="quantity" value={quantity} /><button type="submit" disabled={disabled} aria-label={label}>{children}</button></Form>;
}
