import {Form, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/shop.cart';
import {
  AppUnavailable,
  type Quote,
  appOp,
  cleanLines,
  formatMoney,
  orderCookie,
  readCart,
  requireAppCommerce,
  writeCart,
} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';

export const meta: Route.MetaFunction = () => [{title: 'Cart'}, {name: 'robots', content: 'noindex, nofollow'}];

const RAILS = [
  {id: 'mollie', label: 'Bancontact, iDEAL or card (Mollie)'},
  {id: 'stripe', label: 'Card or wallet (Stripe)'},
  {id: 'paypal', label: 'PayPal'},
  {id: 'bank_transfer', label: 'Bank transfer'},
] as const;

function countryOf(request: Request): string {
  const url = new URL(request.url);
  const q = (url.searchParams.get('country') ?? request.headers.get('CF-IPCountry') ?? 'BE').toUpperCase();
  return /^[A-Z]{2}$/.test(q) ? q : 'BE';
}

export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const lines = await readCart(request, context.env);
  const country = countryOf(request);
  if (!lines.length) return {lines, country, quote: null, problem: null};
  try {
    const out = await appOp<Quote>(context.env, 'storefront.quote', {lines, country});
    return {lines, country, quote: out.ok ? out.data ?? null : null, problem: out.ok ? null : out.error?.detail ?? 'Cannot price this cart'};
  } catch (err) {
    if (err instanceof AppUnavailable) return {lines, country, quote: null, problem: 'Checkout cannot be reached right now. Try again in a minute.'};
    throw err;
  }
}

export async function action({context, request}: Route.ActionArgs) {
  requireAppCommerce(context.env);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const lines = await readCart(request, context.env);
  if (intent === 'remove') {
    const v = String(form.get('variant') ?? '');
    return redirect('/shop/cart', {headers: {'Set-Cookie': await writeCart(lines.filter((l) => l.variant !== v), context.env)}});
  }
  if (intent !== 'checkout') return redirect('/shop/cart');
  const origin = new URL(request.url).origin;
  const out = await appOp<{number: string; token: string | null; redirect_url: string | null}>(context.env, 'storefront.checkout', {
    lines: cleanLines(lines),
    country: String(form.get('country') ?? ''),
    email: String(form.get('email') ?? ''),
    rail: String(form.get('rail') ?? ''),
    request_key: String(form.get('request_key') ?? ''),
    return_url: `${origin}/shop/order`,
  });
  if (!out.ok || !out.data) {
    return redirect(`/shop/cart?problem=${encodeURIComponent(out.error?.detail ?? 'Checkout failed')}`);
  }
  const headers = new Headers();
  if (out.data.token) headers.append('Set-Cookie', await orderCookie(context.env).serialize({number: out.data.number, token: out.data.token}));
  headers.append('Set-Cookie', await writeCart([], context.env));
  return redirect(out.data.redirect_url ?? `/shop/order?order=${encodeURIComponent(out.data.number)}`, {headers});
}

export default function ShopCart() {
  const {lines, country, quote, problem} = useLoaderData<typeof loader>();
  const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
  return (
    <ShopFrame title="Cart">
      {!lines.length ? <p>Your cart is empty.</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {quote ? (
        <>
          <table className="w-full">
            <tbody>
              {quote.lines.map((l) => (
                <tr key={l.variant}>
                  <td>
                    {l.title} {l.variant_title} x {l.qty}
                  </td>
                  <td className="text-right">{formatMoney(l.total_minor, quote.currency)}</td>
                  <td className="text-right">
                    <Form method="post">
                      <input type="hidden" name="intent" value="remove" />
                      <input type="hidden" name="variant" value={l.variant} />
                      <button type="submit">Remove</button>
                    </Form>
                  </td>
                </tr>
              ))}
              <tr>
                <td>Shipping to {country}</td>
                <td className="text-right">{formatMoney(quote.shipping_minor, quote.currency)}</td>
              </tr>
              <tr>
                <td className="font-semibold">Total</td>
                <td className="text-right font-semibold">{formatMoney(quote.total_minor, quote.currency)}</td>
              </tr>
              <tr>
                <td>Includes VAT ({quote.vat_rate}%)</td>
                <td className="text-right">{formatMoney(quote.vat_included_minor, quote.currency)}</td>
              </tr>
            </tbody>
          </table>
          <Form method="post" className="mt-6 grid gap-3">
            <input type="hidden" name="intent" value="checkout" />
            <input type="hidden" name="country" value={country} />
            <input type="hidden" name="request_key" value={key} />
            <label className="grid gap-1">
              <span>Email</span>
              <input name="email" type="email" required autoComplete="email" className="border p-2" />
            </label>
            <fieldset className="grid gap-1">
              <legend>Payment</legend>
              {RAILS.map((r, i) => (
                <label key={r.id} className="flex gap-2">
                  <input type="radio" name="rail" value={r.id} defaultChecked={i === 0} required />
                  {r.label}
                </label>
              ))}
            </fieldset>
            <button type="submit" className="border px-4 py-2 font-semibold">
              Pay {formatMoney(quote.total_minor, quote.currency)}
            </button>
          </Form>
        </>
      ) : null}
    </ShopFrame>
  );
}
