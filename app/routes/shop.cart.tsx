import {Form, Link, redirect, useActionData, useLoaderData, useNavigate, useNavigation} from 'react-router';
import {useEffect, useMemo, useState} from 'react';
import type {Route} from './+types/shop.cart';
import {
  type AppCatalog,
  AppUnavailable,
  type CartLine,
  type Quote,
  appOp,
  cleanLines,
  edgeCache,
  formatMoney,
  orderCookie,
  readCart,
  requireAppCommerce,
  returnOrigin,
  snapshot,
  writeCart,
} from '~/lib/commerce/app-api';
import {readOptions, writeOptions} from '~/lib/commerce/app-cart-options';
import {ShopFrame} from '~/components/commerce/ShopFrame';
import {OrderSummary, type SummaryImages} from '~/components/commerce/OrderSummary';
import {PaymentRails} from '~/components/commerce/PaymentRails';
import {AddressFields, type AddressFill} from '~/components/commerce/AddressFields';
import {ExpressCheckout} from '~/components/commerce/ExpressCheckout';
import {pickCountry, requestCountry} from '~/lib/commerce/address-fields';
import {addressProvider} from '~/lib/commerce/address-provider';
import {expressConfig, type ExpressResult} from '~/lib/commerce/payment-provider';

export const meta: Route.MetaFunction = () => [{title: 'Checkout'}, {name: 'robots', content: 'noindex, nofollow'}];

function countryOf(request: Request): string {
  const url = new URL(request.url);
  const q = (url.searchParams.get('country') ?? requestCountry(request) ?? 'BE').toUpperCase();
  return /^[A-Z]{2}$/.test(q) ? q : 'BE';
}

async function imagesFor(env: Parameters<typeof snapshot>[0], lines: CartLine[]): Promise<SummaryImages> {
  try {
    const cat = await snapshot<AppCatalog>(env, 'storefront.catalog', edgeCache());
    const out: SummaryImages = {};
    for (const l of lines) out[l.variant] = cat.products.find((p) => p.variants.some((v) => v.id === l.variant))?.image ?? null;
    return out;
  } catch {
    return {};
  }
}

export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const lines = await readCart(request, context.env);
  let country = countryOf(request);
  const smart = {suggest: addressProvider(context.env).id !== 'none', express: expressConfig(context.env)};
  const options = await readOptions(request, context.env);
  if (!lines.length) return {lines, country, quote: null, problem: null, images: {} as SummaryImages, code: '', ...smart};
  const images = await imagesFor(context.env, lines);
  const code = options.code;
  try {
    let out = await appOp<Quote>(context.env, 'storefront.quote', {lines, country, discount_code: code, pickup: options.pickup});
    // Pickup chosen for a country that does not offer it (the picker moved): price the shipped order.
    if (!out.ok && options.pickup && /pickup/i.test(out.error?.detail ?? '')) {
      out = await appOp<Quote>(context.env, 'storefront.quote', {lines, country, discount_code: code});
    }
    // A country the app does not ship to (a visitor's own, say): quote Belgium, the picker shows what is offered.
    if (!out.ok && country !== 'BE' && /ship to this country/i.test(out.error?.detail ?? '')) {
      country = 'BE';
      out = await appOp<Quote>(context.env, 'storefront.quote', {lines, country, discount_code: code});
    }
    // The visitor's country is preselected only when the app ships there, else the first country it ships to.
    const ship = out.ok ? out.data?.ship_countries : undefined;
    if (out.ok && ship?.length && pickCountry(country, ship) !== country) {
      country = pickCountry(country, ship);
      out = await appOp<Quote>(context.env, 'storefront.quote', {lines, country, discount_code: code});
    }
    return {lines, country, quote: out.ok ? out.data ?? null : null, problem: out.ok ? null : out.error?.detail ?? 'Cannot price this cart', images, code, ...smart};
  } catch (err) {
    if (err instanceof AppUnavailable) {
      return {lines, country, quote: null, problem: 'Checkout cannot be reached right now. Try again in a minute.', images, code, ...smart};
    }
    throw err;
  }
}

const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

export async function action({context, request}: Route.ActionArgs) {
  requireAppCommerce(context.env);
  const form = await request.formData();
  const intent = field(form, 'intent');
  const lines = await readCart(request, context.env);
  if (intent === 'remove' || intent === 'qty') {
    const v = field(form, 'variant');
    const qty = Number(field(form, 'qty'));
    const next: CartLine[] =
      intent === 'remove' ? lines.filter((l) => l.variant !== v) : lines.map((l) => (l.variant === v && Number.isInteger(qty) ? {...l, qty} : l));
    return Response.json({ok: true}, {headers: {'Set-Cookie': await writeCart(cleanLines(next), context.env)}});
  }
  if (intent === 'discount' || intent === 'pickup') {
    const current = await readOptions(request, context.env);
    const next = intent === 'discount' ? {...current, code: field(form, 'code')} : {...current, pickup: field(form, 'on') === '1'};
    return Response.json({ok: true}, {headers: {'Set-Cookie': await writeOptions(next, context.env)}});
  }
  if (intent !== 'checkout') return redirect('/shop/cart');
  const origin = new URL(request.url).origin;
  const country = field(form, 'country').toUpperCase();
  const out = await appOp<{number: string; token: string | null; redirect_url: string | null}>(context.env, 'storefront.checkout', {
    lines: cleanLines(lines),
    country,
    email: field(form, 'email'),
    rail: field(form, 'rail'),
    request_key: field(form, 'request_key') || crypto.randomUUID(),
    return_url: `${returnOrigin(origin, import.meta.env.DEV)}/shop/order`,
    shipping_address: {
      name: field(form, 'name'),
      line1: field(form, 'line1'),
      line2: field(form, 'line2'),
      postal_code: field(form, 'postal_code'),
      city: field(form, 'city'),
      country,
      phone: field(form, 'phone'),
    },
    billing_same: true,
    discount_code: field(form, 'discount_code'),
    pickup: field(form, 'pickup') === '1',
    note: field(form, 'note'),
  });
  if (!out.ok || !out.data) return {problem: friendly(out.error?.code, out.error?.detail)};
  const headers = new Headers();
  if (out.data.token) headers.append('Set-Cookie', await orderCookie(context.env).serialize({number: out.data.number, token: out.data.token}));
  headers.append('Set-Cookie', await writeCart([], context.env));
  headers.append('Set-Cookie', await writeOptions({code: '', pickup: false}, context.env));
  return redirect(out.data.redirect_url ?? `/shop/order?order=${encodeURIComponent(out.data.number)}`, {headers});
}

function friendly(code?: string, detail?: string): string {
  if (code === 'bad_args') return 'Check the address and phone number, then try again.';
  return detail || 'We could not place the order. Try again.';
}

function Field({label, name, optional, className = '', ...rest}: {label: string; name: string; optional?: boolean; className?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`co-field ${className}`}>
      <span>
        {label}
        {optional ? <em> (optional)</em> : null}
      </span>
      <input name={name} required={!optional} {...rest} />
    </label>
  );
}

/** A wallet's email goes into the contact step's own field, set the way a browser autofill does so React sees it. */
function fillEmail(value: string) {
  const input = document.querySelector<HTMLInputElement>('#checkout input[name="email"]');
  if (!input || !value || input.value) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', {bubbles: true}));
}

export default function ShopCart() {
  const {lines, country, quote, problem, images, code, suggest, express} = useLoaderData<typeof loader>();
  const [fill, setFill] = useState<AddressFill | null>(null);
  const actionData = useActionData<{problem?: string}>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  useEffect(() => setKey(crypto.randomUUID()), [actionData]);
  const countries = useMemo(() => {
    const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], {type: 'region'}) : null;
    const codes = quote?.ship_countries?.length ? quote.ship_countries : [country];
    return codes.map((c) => ({code: c, name: names?.of(c) ?? c})).sort((a, b) => a.name.localeCompare(b.name));
  }, [quote, country]);
  const busy = navigation.state !== 'idle';
  const submitting = navigation.formData?.get('intent') === 'checkout';
  const shown = actionData?.problem ?? problem;

  return (
    <ShopFrame title="Checkout" wide>
      {!lines.length ? (
        <p className="app-shop-note">
          Your cart is empty. <Link to="/products">Browse the products</Link>.
        </p>
      ) : null}
      {shown ? (
        <p role="alert" className="app-shop-problem">
          {shown}
        </p>
      ) : null}
      {quote ? (
        <div className="co">
          <Form method="post" className="co-form" id="checkout">
            <input type="hidden" name="intent" value="checkout" />
            <input type="hidden" name="request_key" value={key} />
            <ExpressCheckout config={express} total={quote.total_minor} currency={quote.currency} countries={countries.map((c) => c.code)}
              onFill={(r: ExpressResult) => { setFill({...r.address, name: r.name, phone: r.phone}); fillEmail(r.email); }} />
            <section className="co-section">
              <h2 className="co-h">Contact</h2>
              <Field label="Email" name="email" type="email" autoComplete="email" inputMode="email" />
              <p className="co-quiet">Checking out as a guest. Accounts are optional.</p>
            </section>
            <section className="co-section">
              <h2 className="co-h">Delivery</h2>
              <AddressFields country={country} countries={countries} suggest={suggest} fill={fill} onCountry={(c) => void navigate(`/shop/cart?country=${c}`, {replace: true, preventScrollReset: true})} />
            </section>
            <section className="co-section">
              <PaymentRails />
            </section>
            <button type="submit" className="co-pay" disabled={busy}>
              {submitting ? 'Placing order...' : `Pay ${formatMoney(quote.total_minor, quote.currency)}`}
            </button>
          </Form>
          <OrderSummary quote={quote} country={country} images={images} code={code} pending={busy && !submitting} />
        </div>
      ) : null}
    </ShopFrame>
  );
}
