import {data, redirect, useLoaderData, Link} from 'react-router';
import type {Route} from './+types/account._index';
import {accountHeaders, accountsEnabled, redirectTo, sameOrigin} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {HISTORY_NOTICES, type HistoryNotice} from '~/lib/accounts/rights';
import {clearSessionCookie, hasSessionCookie, readSession} from '~/lib/accounts/sessions';
import {readCustomerAccount, type AccountShopifyData} from '~/lib/accounts/customer-shopify';
import {formatOrderDate, formatOrderMoney, orderItems, orderStatus} from '~/lib/accounts/order-display';
import {subscribeWithShopify, unsubscribeWithShopify} from '~/lib/growth/shopify-newsletter';
import {customerAccountUrl} from '~/lib/shop-links';
import {supportHeaders} from '~/lib/support/server';
import {CAMPAIGN} from '~/lib/catalog-client';

/**
 * GET /account with ACCOUNTS_ENABLED "1": the signed-in dashboard.
 *
 * Identity (email), orders and newsletter consent are read LIVE from
 * Shopify by the session's shopify_gid on every request
 * (readCustomerAccount, customer-shopify.ts): Shopify owns that record
 * (migrations/0005_accounts.sql), so nothing here stores email, name or
 * orders - a failed read just falls back to the plain Shopify account link.
 * Orders and addresses stay in Shopify customer accounts: customerAccountUrl
 * resolves SHOPIFY_CUSTOMER_ACCOUNT_URL when set, else derives it from the
 * numeric SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID the sign-in OIDC client already
 * uses (app/lib/shop-links.ts). The newsletter toggle (POST here) reuses
 * subscribeWithShopify/unsubscribeWithShopify (growth/shopify-newsletter.ts).
 * ChatFPV history export and delete post to /account/chatfpv-history and
 * live in the collapsed "Settings and data" section - ChatFPV is not a
 * primary account feature, so it gets no top-level card. Sign out posts to
 * /account/logout. Signed out, it starts sign-in. Flag off: the legacy
 * Shopify redirect.
 *
 * In local dev (import.meta.env.DEV, folded to `false` and dropped by the
 * production build - same rule as app/lib/support/dev-overrides.ts) every
 * Shopify customer read and every newsletter write is mocked: a local run
 * never touches the shared store. The mock is keyed off the test IdP's own
 * customer picker (account/test-idp/authorize.tsx): the first test customer
 * renders a full mock account, the second an empty one, and typing any
 * other test GID shows the fallback state.
 */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Your account | OpenDrone'}, {name: 'robots', content: 'noindex, nofollow'}];

const NEWSLETTER_NOTICES = ['ok', 'unavailable'] as const;
type NewsletterNotice = (typeof NEWSLETTER_NOTICES)[number];

function devMockAccount(shopifyGid: string): AccountShopifyData | null {
  if (shopifyGid === 'gid://shopify/Customer/test-1') {
    return {
      email: 'jane@example.com',
      newsletter: 'SUBSCRIBED',
      orders: [
        {
          id: 'mock-order-1',
          name: '#1001',
          createdAt: '2026-09-29T09:00:00Z',
          statusPageUrl: 'https://opendrone-test.myshopify.com/orders/1/authenticate?key=mock',
          lines: [
            {sku: 'OPENFRAME-5', name: 'OpenFrame', variant: '5" Freestyle', quantity: 1},
            {sku: 'OPENMOTOR-2306', name: 'OpenMotor', variant: '2306', quantity: 4},
            {sku: 'OPENRX-MONO', name: 'OpenRX', variant: 'Mono', quantity: 1},
            {sku: 'PROP-HQ-5043', name: 'HQProp 5x4.3x3 V2S propeller set', variant: '5 inch', quantity: 1},
            {sku: 'OPENESC-3030', name: 'OpenESC', variant: '30×30', quantity: 1},
            {sku: 'OPENFC-LITE-3030', name: 'OpenFC Lite', variant: '30×30', quantity: 1},
          ],
          total: {amount: '612.40', currencyCode: 'EUR'},
          fulfillmentStatus: 'UNFULFILLED',
          financialStatus: 'PAID',
          cancelled: false,
          isPreorder: true,
          // The latest of the lines' promises: the "early November 2026"
          // line does not decide it, the March funding targets do.
          promise: {kind: 'target', day: '2027-03-31', text: 'ships by 31 Mar 2027'},
        },
        {
          id: 'mock-order-2',
          name: '#1031',
          createdAt: '2026-09-14T09:00:00Z',
          statusPageUrl: 'https://opendrone-test.myshopify.com/orders/2/authenticate?key=mock',
          lines: [
            {sku: 'ACC-STRAP-15X200', name: 'Battery strap 15x200', variant: null, quantity: 2},
            {sku: 'ACC-XT60', name: 'XT60 pigtail', variant: '10 cm', quantity: 1},
          ],
          total: {amount: '18.50', currencyCode: 'EUR'},
          fulfillmentStatus: 'FULFILLED',
          financialStatus: 'PAID',
          cancelled: false,
          isPreorder: false,
          promise: null,
        },
        {
          id: 'mock-order-3',
          name: '#1024',
          createdAt: '2026-09-02T09:00:00Z',
          statusPageUrl: null,
          lines: [{sku: 'OPENFC-LITE-2020', name: 'OpenFC Lite', variant: '20×20', quantity: 1}],
          total: {amount: '89.00', currencyCode: 'EUR'},
          fulfillmentStatus: 'UNFULFILLED',
          financialStatus: 'PAID',
          cancelled: false,
          isPreorder: true,
          promise: {kind: 'date', day: '2026-11-05', text: 'ships early Nov 2026'},
        },
      ],
    };
  }
  if (shopifyGid === 'gid://shopify/Customer/test-2') {
    return {email: 'sam@example.com', newsletter: 'UNSUBSCRIBED', orders: []};
  }
  return null;
}

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('', env);
  const session = await readSession(env.SUPPORT_DB, request);
  if (!session) {
    // A stale cookie (expired or revoked session) goes, so the header says "Sign in" again.
    const headers = new Headers({'Cache-Control': 'no-store'});
    if (hasSessionCookie(request)) headers.append('Set-Cookie', clearSessionCookie());
    throw redirect('/account/login?return_to=%2Faccount', {headers});
  }
  const headers = new Headers({'Cache-Control': 'no-store'});
  if (session.refreshCookie) headers.append('Set-Cookie', session.refreshCookie);
  const url = new URL(request.url);
  const rawChatfpv = url.searchParams.get('chatfpv');
  const notice = (HISTORY_NOTICES as readonly string[]).includes(rawChatfpv ?? '') ? (rawChatfpv as HistoryNotice) : null;
  const rawNewsletter = url.searchParams.get('newsletter');
  const newsletterNotice = (NEWSLETTER_NOTICES as readonly string[]).includes(rawNewsletter ?? '')
    ? (rawNewsletter as NewsletterNotice)
    : null;
  const ordersUrl = customerAccountUrl(env);
  const shopify = import.meta.env.DEV ? devMockAccount(session.shopifyGid) : await readCustomerAccount(env, session.shopifyGid, CAMPAIGN);
  return data(
    {ordersUrl, since: new Date(session.createdAt).toISOString().slice(0, 10), notice, newsletterNotice, shopify},
    {headers},
  );
}

/** POST /account: the newsletter toggle only (ChatFPV history has its own route). */
export async function action({request, context}: Route.ActionArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('', env);
  if (request.method !== 'POST' || !sameOrigin(request)) {
    return new Response('Forbidden', {status: 403, headers: accountHeaders()});
  }
  const session = await readSession(env.SUPPORT_DB, request);
  if (!session) return redirectTo('/account/login?return_to=%2Faccount', [], 303);
  const form = await request.formData();
  const intent = form.get('intent');
  if (intent !== 'newsletter-subscribe' && intent !== 'newsletter-unsubscribe') {
    return new Response('Bad Request', {status: 400, headers: accountHeaders()});
  }
  if (import.meta.env.DEV) {
    // Never write to the shared Shopify store from a local run - see the
    // loader's devMockAccount and app/lib/support/dev-overrides.ts.
    return redirectTo('/account?newsletter=ok', [], 303);
  }
  const account = await readCustomerAccount(env, session.shopifyGid, CAMPAIGN);
  if (!account?.email) return redirectTo('/account?newsletter=unavailable', [], 303);
  const result =
    intent === 'newsletter-subscribe'
      ? await subscribeWithShopify(env, account.email)
      : await unsubscribeWithShopify(env, account.email);
  const ok = result === 'subscribed' || result === 'already-subscribed' || result === 'unsubscribed';
  return redirectTo(`/account?newsletter=${ok ? 'ok' : 'unavailable'}`, [], 303);
}

const NOTICE_TEXT: Record<HistoryNotice, string> = {
  deleted: 'Your ChatFPV history is deleted.',
  unavailable: 'ChatFPV did not answer. Nothing changed; try again later.',
  confirm: 'Tick the box to confirm the delete.',
};

const NEWSLETTER_NOTICE_TEXT: Record<NewsletterNotice, string> = {
  ok: 'Newsletter preference updated.',
  unavailable: 'Could not update your newsletter preference. Try again later.',
};

export default function AccountRoute() {
  const {ordersUrl, since, notice, newsletterNotice, shopify} = useLoaderData<typeof loader>();

  return (
    <div className="page-shell sp-page">
      <header className="page-header account-header">
        <h1 className="page-title">Your account</h1>
        <div className="account-identity">
          <p className="page-description">
            {shopify?.email ? <>{shopify.email} · </> : null}Signed in since {since}.
          </p>
          <form method="post" action="/account/logout" className="account-identity-signout">
            <button type="submit" className="od-btn od-btn-secondary od-btn-sm">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="account-orders-card" aria-labelledby="account-orders-title">
        <h2 id="account-orders-title" className="account-dashboard-card-title">
          Orders
        </h2>
        {shopify && shopify.orders.length > 0 ? (
          <>
            <ul className="account-orders-list">
              {shopify.orders.map((order) => {
                const status = orderStatus(order);
                const {shown, more} = orderItems(order.lines);
                const total = formatOrderMoney(order.total);
                return (
                  <li key={order.id} className="account-order">
                    <div className="account-order-head">
                      <p className="account-order-id">
                        <span className="account-order-number">{order.name}</span>
                        <span className="account-order-date">{formatOrderDate(order.createdAt)}</span>
                      </p>
                      {total ? <span className="account-order-total">{total}</span> : null}
                    </div>
                    <span className="account-order-chip" data-tone={status.tone}>
                      {status.label}
                    </span>
                    {shown.length > 0 ? (
                      <ul className="account-order-items">
                        {shown.map((item) => (
                          <li key={`${item.name}|${item.variant ?? ''}`}className="account-order-item">
                            <span className="account-order-qty">{item.quantity}×</span>
                            <span>
                              {item.name}
                              {item.variant ? <span className="account-order-variant">{item.variant}</span> : null}
                            </span>
                          </li>
                        ))}
                        {more > 0 ? <li className="account-order-more">+{more} more</li> : null}
                      </ul>
                    ) : (
                      <p className="account-order-note">No items.</p>
                    )}
                    {status.note ? <p className="account-order-note">{status.note}</p> : null}
                    {order.statusPageUrl ? (
                      <a href={order.statusPageUrl} className="account-dashboard-card-link account-order-view">
                        View order ›
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {ordersUrl ? (
              <a href={ordersUrl} className="account-dashboard-card-link account-orders-all">
                All orders and addresses ›
              </a>
            ) : null}
          </>
        ) : shopify ? (
          <>
            <p className="account-dashboard-card-lede">No orders yet.</p>
            {ordersUrl ? (
              <a href={ordersUrl} className="account-dashboard-card-link account-orders-all">
                All orders and addresses ›
              </a>
            ) : null}
          </>
        ) : ordersUrl ? (
          <>
            <p className="account-dashboard-card-lede">We can&rsquo;t show your recent orders right now.</p>
            <a href={ordersUrl} className="account-dashboard-cta">
              Orders and addresses
            </a>
          </>
        ) : (
          <>
            <p className="account-dashboard-card-lede">
              We don&rsquo;t have a link for your orders and addresses right now. Check your order confirmation email, or reach support with your
              order number.
            </p>
            <div className="account-dashboard-card-actions">
              <Link to="/support?topic=order" className="account-dashboard-cta">
                Open a support ticket
              </Link>
              <Link to="/support/find" className="account-dashboard-card-link">
                Find an existing ticket
              </Link>
            </div>
          </>
        )}
      </section>

      <div className="account-dashboard-grid">
        <section className="account-dashboard-card" aria-labelledby="account-newsletter-title">
          <p className="account-dashboard-eyebrow-mono">Newsletter</p>
          <h2 id="account-newsletter-title" className="account-dashboard-card-title">
            Newsletter
          </h2>
          {shopify ? (
            <>
              <p className="account-dashboard-card-lede">
                {shopify.newsletter === 'SUBSCRIBED' ? 'Subscribed to Engineering Essentials.' : 'Not subscribed.'}
              </p>
              {newsletterNotice ? (
                <p className="account-chatfpv-notice" role="status">
                  {NEWSLETTER_NOTICE_TEXT[newsletterNotice]}
                </p>
              ) : null}
              <form method="post" className="account-dashboard-card-actions">
                <input
                  type="hidden"
                  name="intent"
                  value={shopify.newsletter === 'SUBSCRIBED' ? 'newsletter-unsubscribe' : 'newsletter-subscribe'}
                />
                <button type="submit" className="account-dashboard-cta">
                  {shopify.newsletter === 'SUBSCRIBED' ? 'Unsubscribe' : 'Subscribe'}
                </button>
              </form>
            </>
          ) : (
            <p className="account-dashboard-card-lede">Manage this from the newsletter signup in the footer.</p>
          )}
        </section>

        <section className="account-dashboard-card" aria-labelledby="account-discord-title">
          <p className="account-dashboard-eyebrow-mono">Discord</p>
          <h2 id="account-discord-title" className="account-dashboard-card-title">
            Early Bird role
          </h2>
          <p className="account-dashboard-card-lede">A paid preorder unlocks the Early Bird role and #early-birds on the OpenDrone Discord.</p>
          <div className="account-dashboard-card-actions">
            <Link to="/early-bird" className="account-dashboard-cta">
              Claim on Discord
            </Link>
          </div>
        </section>

        <section className="account-dashboard-card" aria-labelledby="account-support-title">
          <p className="account-dashboard-eyebrow-mono">Support</p>
          <h2 id="account-support-title" className="account-dashboard-card-title">
            Support tickets
          </h2>
          <p className="account-dashboard-card-lede">Open a new ticket or look up one you already opened, no account needed to file it.</p>
          <div className="account-dashboard-card-actions">
            <Link to="/support" className="account-dashboard-cta">
              Open a ticket
            </Link>
            <Link to="/support/find" className="account-dashboard-card-link">
              Find my ticket
            </Link>
          </div>
        </section>
      </div>

      <details className="details-toggle account-settings">
        <summary className="details-toggle-summary">Settings and data</summary>
        <div className="details-toggle-body">
          <div className="account-chatfpv" aria-labelledby="account-chatfpv-title">
            <h3 id="account-chatfpv-title" className="account-chatfpv-title">
              ChatFPV history
            </h3>
            <p>Your chatfpv.com conversations made while signed in (same sign-in as here). Export them as JSON, or delete them for good.</p>
            {notice ? (
              <p className="account-chatfpv-notice" role="status">
                {NOTICE_TEXT[notice]}
              </p>
            ) : null}
            <form method="post" action="/account/chatfpv-history" className="account-chatfpv-export">
              <input type="hidden" name="intent" value="export" />
              <button type="submit" className="od-btn od-btn-secondary">
                Export ChatFPV history
              </button>
            </form>
            <form method="post" action="/account/chatfpv-history" className="account-chatfpv-delete">
              <input type="hidden" name="intent" value="delete" />
              <label>
                <input type="checkbox" name="confirm" value="yes" required /> Delete every ChatFPV conversation of this account
              </label>
              <button type="submit" className="od-btn od-btn-danger">
                Delete ChatFPV history
              </button>
            </form>
          </div>
          <div className="account-settings-delete">
            <h3 className="account-chatfpv-title">Delete your account</h3>
            <p>To close your OpenDrone account, open a support ticket and we will process it.</p>
            <Link to="/support?topic=other" className="account-dashboard-card-link">
              Contact support ›
            </Link>
          </div>
        </div>
      </details>
    </div>
  );
}
