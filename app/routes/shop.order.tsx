import {useLoaderData} from 'react-router';
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
};

const PAYMENT_WORDS: Record<string, string> = {
  none: 'Waiting for your payment.',
  pending_async: 'Payment started. We confirm it as soon as the money is in.',
  paid: 'Paid. Your order is confirmed.',
  failed: 'The payment did not go through. Nothing was charged.',
  partially_refunded: 'Partly refunded.',
  refunded: 'Refunded.',
};

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

export default function ShopOrder() {
  const {status, problem} = useLoaderData<typeof loader>();
  return (
    <ShopFrame title={status ? `Order ${status.number}` : 'Order'}>
      {problem ? <p className="app-shop-note">{problem}</p> : null}
      {status ? (
        <div className="app-shop-order">
          <p className="app-shop-state">{PAYMENT_WORDS[status.state.payment] ?? status.state.payment}</p>
          <p className="app-shop-total-line">Total {formatMoney(status.quote.total_minor, status.quote.currency)}</p>
          {status.bank && status.state.payment !== 'paid' ? (
            <dl className="app-shop-bank">
              <dt>Account</dt>
              <dd>{status.bank.iban || 'not configured'}</dd>
              <dt>Reference</dt>
              <dd>{status.bank.reference}</dd>
              <dt>Amount</dt>
              <dd>
                {status.bank.currency} {status.bank.amount}
              </dd>
            </dl>
          ) : null}
        </div>
      ) : null}
    </ShopFrame>
  );
}
