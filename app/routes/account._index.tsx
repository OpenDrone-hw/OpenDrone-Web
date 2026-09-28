import {data, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/account._index';
import {accountsEnabled} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {HISTORY_NOTICES, type HistoryNotice} from '~/lib/accounts/rights';
import {clearSessionCookie, hasSessionCookie, readSession} from '~/lib/accounts/sessions';
import {customerAccountUrl} from '~/lib/shop-links';
import {supportHeaders} from '~/lib/support/server';

/**
 * GET /account with ACCOUNTS_ENABLED "1": the signed-in page. Orders and
 * addresses stay in Shopify customer accounts (SHOPIFY_CUSTOMER_ACCOUNT_URL,
 * unchanged); ChatFPV history export and delete post to
 * /account/chatfpv-history; sign out posts to /account/logout. Signed out, it starts
 * sign-in. Flag off: the legacy Shopify redirect.
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
  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <h1 className="page-title">Your account</h1>
        <p className="page-description">Signed in since {since}. This sign-in also works on chatfpv.com.</p>
      </header>
      <div className="sp-narrow">
        <section className="sp-card account-card">
          {ordersUrl ? (
            <p>
              <a href={ordersUrl} className="od-btn od-btn-secondary account-orders">
                Orders and addresses
              </a>
            </p>
          ) : null}
          <section className="account-chatfpv" aria-labelledby="account-chatfpv-title">
            <h2 id="account-chatfpv-title" className="account-chatfpv-title">
              ChatFPV history
            </h2>
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
              <button type="submit" className="od-btn od-btn-ghost">
                Delete ChatFPV history
              </button>
            </form>
          </section>
          <form method="post" action="/account/logout" className="account-logout">
            <button type="submit" className="od-btn od-btn-ghost">
              Sign out
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
