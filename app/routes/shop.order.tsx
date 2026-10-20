import {useLoaderData, useRouteLoaderData} from 'react-router';
import {OrdersLinkCard} from '~/components/commerce/OrdersLinkCard';
import {appAccountsEnabled, requestLink, verifyUrl} from '~/lib/commerce/app-account';
import type {Route} from './+types/shop.order';
import {AppUnavailable, appOp, formatMoney, orderCookie, requireAppCommerce} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';

export const meta: Route.MetaFunction = () => [{title: 'Order'}, {name: 'robots', content: 'noindex, nofollow'}];

type Status = {
  number: string;
  rail: string;
  rail_state: string;
  state: {payment: string; fulfilment: string};
  quote: {total_minor: number; currency: string};
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

export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const saved = (await orderCookie(context.env).parse(request.headers.get('Cookie'))) as {number?: string; token?: string} | null;
  const asked = new URL(request.url).searchParams.get('order');
  if (!saved?.number || !saved.token || (asked && asked !== saved.number)) return {status: null, problem: 'No order to show on this device.'};
  try {
    const out = await appOp<Status>(context.env, 'storefront.order_status', {number: saved.number, token: saved.token});
    return {status: out.ok ? out.data ?? null : null, problem: out.ok ? null : 'No order to show on this device.'};
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
            <dl className="co-kv">
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
          {root?.appAccounts ? <OrdersLinkCard signedIn={Boolean(root.appSignedIn)} /> : null}
        </div>
      ) : null}
    </ShopFrame>
  );
}
