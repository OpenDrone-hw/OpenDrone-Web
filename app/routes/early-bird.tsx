import {data, Link, useLoaderData} from 'react-router';
import type {Route} from './+types/early-bird';
import {accountHeaders, accountsEnabled, redirectTo, sameOrigin} from '~/lib/accounts/config';
import {readSession} from '~/lib/accounts/sessions';
import {formatOrderDate} from '~/lib/accounts/order-display';
import {CAMPAIGN} from '~/lib/catalog-client';
import {
  claimUrl,
  ineligibility,
  mailKeyMatches,
  orderGid,
  readCustomerOrders,
  readOrder,
  type EarlyBirdOrder,
  type Ineligible,
} from '~/lib/early-bird';

/**
 * /early-bird: claim the Early Bird role and #early-birds on the OpenDrone
 * Discord with a paid preorder (app/lib/early-bird.ts).
 *
 * | Request | Does |
 * |---|---|
 * | GET `?order=<id>&key=<status page key>` (order confirmation mail) | checks the key and the order, then 303 to the bot's claim route |
 * | GET, signed in | lists the customer's orders with a Claim button on each qualifying one |
 * | GET, signed out | explains and links sign-in |
 * | POST `order=<gid>` (same Origin, signed in) | checks the order is the customer's and qualifies, then 303 to the bot |
 *
 * The bot records which Discord account claimed which order; this route
 * stores nothing.
 */

type Notice = Ineligible | 'mail-invalid' | 'not-yours' | 'unavailable' | 'closed';

const NOTICE_TEXT: Record<Notice, string> = {
  'not-paid': 'This order is not paid yet. Claim once the payment is through.',
  cancelled: 'This order is cancelled.',
  'not-preorder': 'This order has no preorder item. The Early Bird role is for preorder buyers.',
  'too-late': 'This order was placed after the preorder run closed.',
  'mail-invalid': 'This claim link does not match an order. Sign in with the email you ordered with and claim here.',
  'not-yours': 'That order is not on this account.',
  unavailable: 'We could not check the order just now. Try again in a minute.',
  closed: 'Early Bird claims are not open yet.',
};

export const meta: Route.MetaFunction = () => [
  {title: 'Early Bird on Discord | OpenDrone'},
  {name: 'description', content: 'Every paid OpenDrone preorder unlocks the Early Bird role and the private #early-birds channel on the OpenDrone Discord.'},
];

export function headers() {
  return accountHeaders();
}

type OrderRow = {id: string; name: string; createdAt: string; eligible: boolean};

async function toClaim(env: Env, order: EarlyBirdOrder): Promise<Response | Notice> {
  const why = ineligibility(order, CAMPAIGN.endsOn);
  if (why) return why;
  if (!env.EARLY_BIRD_CLAIM_KEY) return 'closed';
  return redirectTo(await claimUrl(env, order), [], 303);
}

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  const url = new URL(request.url);
  const responseHeaders = accountHeaders();
  let notice: Notice | null = null;

  if (url.searchParams.has('order')) {
    const gid = orderGid(url.searchParams.get('order'));
    let order: EarlyBirdOrder | null = null;
    try {
      order = gid ? await readOrder(env, gid) : null;
    } catch (error) {
      console.error('early-bird: order read failed:', error instanceof Error ? error.message : 'unknown');
      notice = 'unavailable';
    }
    if (!notice) {
      if (!order || !mailKeyMatches(order, url.searchParams.get('key'))) notice = 'mail-invalid';
      else {
        const result = await toClaim(env, order);
        if (result instanceof Response) return result;
        notice = result;
      }
    }
  }

  const session = accountsEnabled(env) ? await readSession(env.SUPPORT_DB, request) : null;
  if (session?.refreshCookie) responseHeaders.append('Set-Cookie', session.refreshCookie);
  let orders: OrderRow[] | null = null;
  if (session) {
    try {
      const raw = (await readCustomerOrders(env, session.shopifyGid)) ?? [];
      orders = raw.map((o) => ({id: o.id, name: o.name, createdAt: o.createdAt, eligible: ineligibility(o, CAMPAIGN.endsOn) === null}));
    } catch (error) {
      console.error('early-bird: customer orders read failed:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return data({signedIn: Boolean(session), accounts: accountsEnabled(env), orders, notice, endsOn: CAMPAIGN.endsOn}, {headers: responseHeaders});
}

export async function action({request, context}: Route.ActionArgs) {
  const {env} = context;
  if (request.method !== 'POST' || !sameOrigin(request) || !accountsEnabled(env)) {
    return new Response('Forbidden', {status: 403, headers: accountHeaders()});
  }
  const session = await readSession(env.SUPPORT_DB, request);
  if (!session) return redirectTo('/account/login?return_to=%2Fearly-bird', [], 303);
  const id = String((await request.formData()).get('order') ?? '');
  if (!/^gid:\/\/shopify\/Order\/\d{1,20}$/.test(id)) return new Response('Bad Request', {status: 400, headers: accountHeaders()});
  let order: EarlyBirdOrder | null;
  try {
    order = await readOrder(env, id);
  } catch (error) {
    console.error('early-bird: order read failed:', error instanceof Error ? error.message : 'unknown');
    return data({notice: 'unavailable' as Notice}, {headers: accountHeaders()});
  }
  if (!order || order.customer?.id !== session.shopifyGid) return data({notice: 'not-yours' as Notice}, {headers: accountHeaders()});
  const result = await toClaim(env, order);
  if (result instanceof Response) return result;
  return data({notice: result}, {headers: accountHeaders()});
}

function closeDate(endsOn: string): string {
  return new Date(`${endsOn}T12:00:00Z`).toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'});
}

export default function EarlyBirdRoute({actionData}: Route.ComponentProps) {
  const {signedIn, accounts, orders, notice: loaderNotice, endsOn} = useLoaderData<typeof loader>();
  const notice = (actionData as {notice?: Notice} | undefined)?.notice ?? loaderNotice;
  const eligible = orders?.filter((o) => o.eligible) ?? [];

  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <h1 className="page-title">Early Bird on Discord</h1>
        <p className="page-description">
          Every paid OpenDrone preorder placed by {closeDate(endsOn)} unlocks the Early Bird role and the private #early-birds channel on
          the OpenDrone Discord. One Discord account per order.
        </p>
      </header>

      {notice ? (
        <p className="account-chatfpv-notice" role="status">
          {NOTICE_TEXT[notice]}
        </p>
      ) : null}

      <section className="account-orders-card" aria-labelledby="early-bird-claim-title">
        <h2 id="early-bird-claim-title" className="account-dashboard-card-title">
          Claim with your order
        </h2>
        {signedIn ? (
          orders === null ? (
            <p className="account-dashboard-card-lede">We can&rsquo;t show your orders right now. Try again in a minute, or use the link in your order confirmation email.</p>
          ) : eligible.length === 0 ? (
            <p className="account-dashboard-card-lede">
              No qualifying preorder on this account. Ordered with another email? Sign out and sign in with that one, or use the link in your order
              confirmation email.
            </p>
          ) : (
            <ul className="account-orders-list">
              {eligible.map((order) => (
                <li key={order.id} className="account-order">
                  <div className="account-order-head">
                    <p className="account-order-id">
                      <span className="account-order-number">{order.name}</span>
                      <span className="account-order-date">{formatOrderDate(order.createdAt)}</span>
                    </p>
                  </div>
                  <form method="post">
                    <input type="hidden" name="order" value={order.id} />
                    <button type="submit" className="account-dashboard-cta">
                      Claim on Discord
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )
        ) : accounts ? (
          <>
            <p className="account-dashboard-card-lede">Sign in with the email you ordered with, then pick the order.</p>
            <a href="/account/login?return_to=%2Fearly-bird" className="account-dashboard-cta">
              Sign in to claim
            </a>
          </>
        ) : null}
        <p className="account-dashboard-card-lede">
          Or use the &ldquo;Claim on Discord&rdquo; link in your order confirmation email. No sign-in needed.
        </p>
      </section>

      <section className="account-dashboard-card" aria-labelledby="early-bird-how-title">
        <h2 id="early-bird-how-title" className="account-dashboard-card-title">
          How it works
        </h2>
        <ol>
          <li>Pick the order, or open the link in its confirmation email.</li>
          <li>Discord asks you to authorise OpenDrone with the account the role goes to. Not a member of the server yet? Claiming adds you.</li>
          <li>The account gets the Early Bird role and sees #early-birds. An order already claimed by another account cannot be claimed again.</li>
        </ol>
        <p className="account-dashboard-card-lede">
          We record which Discord account claimed which order, nothing else. See the <Link to="/privacy">privacy policy</Link>. Questions:{' '}
          <Link to="/support?topic=order">open a ticket</Link>.
        </p>
      </section>
    </div>
  );
}
