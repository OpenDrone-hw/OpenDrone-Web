import {data, redirect, useLoaderData, useRouteLoaderData, Link} from 'react-router';
import type {Route} from './+types/account._index';
import {accountsEnabled} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {HISTORY_NOTICES, type HistoryNotice} from '~/lib/accounts/rights';
import {clearSessionCookie, hasSessionCookie, readSession} from '~/lib/accounts/sessions';
import {customerAccountUrl} from '~/lib/shop-links';
import {supportHeaders} from '~/lib/support/server';
import {NewsletterSignup} from '~/components/NewsletterSignup';

/**
 * GET /account with ACCOUNTS_ENABLED "1": the signed-in dashboard. Orders and
 * addresses stay in Shopify customer accounts (SHOPIFY_CUSTOMER_ACCOUNT_URL);
 * unset in production today, so that card falls back to support instead of
 * rendering nothing. ChatFPV history export and delete post to
 * /account/chatfpv-history; sign out posts to /account/logout. Signed out, it
 * starts sign-in. Flag off: the legacy Shopify redirect.
 */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Your account | OpenDrone'}, {name: 'robots', content: 'noindex, nofollow'}];

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
  const raw = new URL(request.url).searchParams.get('chatfpv');
  const notice = (HISTORY_NOTICES as readonly string[]).includes(raw ?? '') ? (raw as HistoryNotice) : null;
  return data({ordersUrl: customerAccountUrl(env), since: new Date(session.createdAt).toISOString().slice(0, 10), notice}, {headers});
}

const NOTICE_TEXT: Record<HistoryNotice, string> = {
  deleted: 'Your ChatFPV history is deleted.',
  unavailable: 'ChatFPV did not answer. Nothing changed; try again later.',
  confirm: 'Tick the box to confirm the delete.',
};

export default function AccountRoute() {
  const {ordersUrl, since, notice} = useLoaderData<typeof loader>();
  const root = useRouteLoaderData('root') as {turnstileSiteKey?: string | null} | undefined;

  return (
    <div className="page-shell sp-page">
      <div className="account-head">
        <header className="page-header">
          <h1 className="page-title">Your account</h1>
          <p className="page-description">Signed in since {since}. This sign-in also works on chatfpv.com.</p>
        </header>
        <form method="post" action="/account/logout" className="account-head-signout">
          <button type="submit" className="od-btn od-btn-secondary od-btn-sm">
            Sign out
          </button>
        </form>
      </div>

      <div className="account-dashboard-grid">
        <section className="account-dashboard-card" aria-labelledby="account-orders-title">
          <p className="account-dashboard-eyebrow-mono">Orders</p>
          <h2 id="account-orders-title" className="account-dashboard-card-title">
            Orders and addresses
          </h2>
          {ordersUrl ? (
            <>
              <p className="account-dashboard-card-lede">Order status, shipping and billing addresses live in your Shopify customer account.</p>
              <a href={ordersUrl} className="account-dashboard-cta">
                Orders and addresses
              </a>
            </>
          ) : (
            <>
              <p className="account-dashboard-card-lede">
                Order and address management is not linked here yet. Check your order confirmation email for order status, or reach support with
                your order number.
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

        <NewsletterSignup variant="compact" turnstileSiteKey={root?.turnstileSiteKey ?? null} className="account-dashboard-card" />

        <section className="account-dashboard-card" aria-labelledby="account-chatfpv-link-title">
          <p className="account-dashboard-eyebrow-mono">ChatFPV</p>
          <h2 id="account-chatfpv-link-title" className="account-dashboard-card-title">
            ChatFPV
          </h2>
          <p className="account-dashboard-card-lede">The FPV assistant at chatfpv.com. Same sign-in there, no separate account to create.</p>
          <a href="https://chatfpv.com" target="_blank" rel="noopener noreferrer" className="account-dashboard-cta">
            Open chatfpv.com
          </a>
        </section>
      </div>

      <section className="account-danger" aria-labelledby="account-danger-title">
        <h2 id="account-danger-title" className="account-danger-title">
          Your data
        </h2>
        <div className="account-danger-card">
          <div className="account-chatfpv" aria-labelledby="account-chatfpv-title">
            <h3 id="account-chatfpv-title" className="account-chatfpv-title">
              ChatFPV history
            </h3>
            <p>Your chatfpv.com conversations made while signed in. Export them as JSON, or delete them for good.</p>
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
        </div>
      </section>
    </div>
  );
}
