import {Fragment} from 'react';
import {useLoaderData, useRouteLoaderData} from 'react-router';
import {OrdersLinkCard} from '~/components/commerce/OrdersLinkCard';
import {appAccountsEnabled, requestLink, verifyUrl} from '~/lib/commerce/app-account';
import type {Route} from './+types/shop.order';
import {AppUnavailable, type AppliedDiscount, appOp, formatMoney, orderCookie, requireAppCommerce} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';
import {safeTrackingUrl, statusProof} from '~/lib/commerce/app-order-status';
import {discountRows, shippingStrike} from '~/lib/commerce/summary-discounts';

export const meta: Route.MetaFunction = () => [{title: 'Order'}, {name: 'robots', content: 'noindex, nofollow'}];

type Status = {
  number: string;
  rail: string;
  rail_state: string;
  state: {payment: string; fulfilment: string};
  quote: {total_minor: number; currency: string; subtotal_minor?: number; shipping_minor?: number; shipping_standard_minor?: number;
    discount?: {code: string; minor: number} | null; discounts?: AppliedDiscount[]; lines?: Array<{title: string; variant_title?: string; qty: number; total_minor: number}>};
  parcels?: Array<{carrier: string | null; tracking_number: string | null; tracking_url: string | null}>;
  canceled?: boolean;
  bank?: {iban: string; reference: string; amount: string; currency: string};
  payment_mode?: string;
  ship_to?: {city: string; country: string};
};

const PAYMENT_WORDS: Record<string, string> = {
  none: 'Waiting for your payment.',
  pending_async: 'Payment started. We confirm it as soon as the money is in.',
  paid: 'Paid. Your order is confirmed.',
  failed: 'The payment did not go through. Nothing was charged.',
  partially_refunded: 'Partly refunded.',
  refunded: 'Refunded.',
};

export async function action({context, request}: Route.ActionArgs) {
  requireAppCommerce(context.env);
  if (!appAccountsEnabled(context.env) || request.headers.get('Origin') !== new URL(request.url).origin) return {sent: false};
  const saved = (await orderCookie(context.env).parse(request.headers.get('Cookie'))) as {number?: string; token?: string} | null;
  if (!saved?.number || !saved.token) return {sent: false};
  return {sent: await requestLink(context.env, {number: saved.number, token: saved.token}, verifyUrl(request, '/account', import.meta.env.DEV))};
}

/** The status link carries a key: never send it on in a Referer, never keep the page in a shared cache. */
export function headers() {
  return {'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store'};
}

export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const saved = (await orderCookie(context.env).parse(request.headers.get('Cookie'))) as {number?: string; token?: string} | null;
  const proof = statusProof(new URL(request.url).searchParams, saved);
  const none = 'No order to show here. Open the link in your order email, or order again on this device.';
  if (!proof) return {status: null, problem: none};
  try {
    const out = await appOp<Status>(context.env, 'storefront.order_status', proof);
    return {status: out.ok ? out.data ?? null : null, problem: out.ok ? null : none};
  } catch (err) {
    if (err instanceof AppUnavailable) return {status: null, problem: 'Order status cannot be reached right now. Try again in a minute.'};
    throw err;
  }
}

function nextSteps(status: Status): string[] {
  if (status.payment_mode === 'none') return ['This is a test order: no payment is taken and nothing will ship.', 'We sent a confirmation mail so you can see what customers get.'];
  if (status.state.payment === 'paid') return ['We confirmed your payment and sent you a confirmation mail.', 'We prepare your order and mail you the tracking details when it ships.'];
  if (status.rail === 'bank_transfer') {
    return [
      'Transfer the amount below from your bank, with the reference exactly as shown.',
      'We confirm by mail as soon as the money is in, usually within one or two working days.',
      'We ship once the payment is confirmed.',
    ];
  }
  return ['We are waiting for your payment provider to confirm the payment. This page updates when it does.', 'We mail you a confirmation, then the tracking details when it ships.'];
}

export default function ShopOrder() {
  const {status, problem} = useLoaderData<typeof loader>();
  const root = useRouteLoaderData('root') as {appAccounts?: boolean; appSignedIn?: boolean} | undefined;
  const test = status?.payment_mode === 'none';
  return (
    <ShopFrame title={status ? 'Thank you for your order' : 'Order'}>
      {problem ? <p className="app-shop-note">{problem}</p> : null}
      {status ? (
        <div className="co-thanks">
          <p className="co-thanks-lead">
            Order <strong>{status.number}</strong>. {test ? 'Test order, not paid.' : PAYMENT_WORDS[status.state.payment] ?? status.state.payment}
          </p>
          <section className="co-card">
            <h2>What happens next</h2>
            <ol className="co-steps">
              {nextSteps(status).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
          </section>
          {status.bank && status.state.payment !== 'paid' ? (
            <section className="co-card">
              <h2>Bank transfer details</h2>
              <dl className="co-kv">
                <dt>Account</dt>
                <dd>{status.bank.iban || 'not configured'}</dd>
                <dt>Reference</dt>
                <dd>{status.bank.reference}</dd>
                <dt>Amount</dt>
                <dd>
                  {status.bank.currency} {status.bank.amount}
                </dd>
              </dl>
            </section>
          ) : null}
          <section className="co-card">
            <h2>Your order</h2>
            {status.canceled ? <p>This order was canceled.</p> : null}
            <dl className="co-kv">
              {status.quote.lines?.map((line) => (
                <Fragment key={`${line.title}/${line.variant_title ?? ''}`}>
                  <dt>
                    {[line.title, line.variant_title].filter(Boolean).join(' ')} x {line.qty}
                  </dt>
                  <dd>{formatMoney(line.total_minor, status.quote.currency)}</dd>
                </Fragment>
              ))}
              {typeof status.quote.subtotal_minor === 'number' && typeof status.quote.shipping_minor === 'number' ? (
                <>
                  <dt>Subtotal</dt>
                  <dd>{formatMoney(status.quote.subtotal_minor, status.quote.currency)}</dd>
                  {discountRows(status.quote as Parameters<typeof discountRows>[0]).map((r) => (
                    <Fragment key={r.key}>
                      <dt>{r.label}</dt>
                      <dd>&minus;{formatMoney(r.minor, status.quote.currency)}</dd>
                    </Fragment>
                  ))}
                  <dt>Shipping</dt>
                  <dd>
                    {shippingStrike(status.quote as Parameters<typeof shippingStrike>[0]) != null ? (
                      <>
                        <s className="co-dim">{formatMoney(shippingStrike(status.quote as Parameters<typeof shippingStrike>[0]) ?? 0, status.quote.currency)}</s>{' '}
                      </>
                    ) : null}
                    {status.quote.shipping_minor === 0 ? 'Free' : formatMoney(status.quote.shipping_minor, status.quote.currency)}
                  </dd>
                </>
              ) : null}
              <dt>Total</dt>
              <dd>{formatMoney(status.quote.total_minor, status.quote.currency)}</dd>
              {status.ship_to ? (
                <>
                  <dt>Shipping to</dt>
                  <dd>
                    {status.ship_to.city}, {status.ship_to.country}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
          {status.parcels?.length ? (
            <section className="co-card">
              <h2>Tracking</h2>
              <dl className="co-kv">
                {status.parcels.map((parcel) => {
                  const href = safeTrackingUrl(parcel.tracking_url);
                  const number = parcel.tracking_number || 'On its way';
                  return (
                    <Fragment key={`${parcel.carrier}/${parcel.tracking_number}`}>
                      <dt>{parcel.carrier || 'Carrier'}</dt>
                      <dd>
                        {href ? (
                          <a href={href} rel="noopener noreferrer">
                            {number}
                          </a>
                        ) : (
                          number
                        )}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
            </section>
          ) : null}
          {root?.appAccounts ? <OrdersLinkCard signedIn={Boolean(root.appSignedIn)} /> : null}
        </div>
      ) : null}
    </ShopFrame>
  );
}
