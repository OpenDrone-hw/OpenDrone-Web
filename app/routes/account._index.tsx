import {data, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/account._index';
import {accountsEnabled} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {readSession} from '~/lib/accounts/sessions';
import {customerAccountUrl} from '~/lib/shop-links';
import {supportHeaders} from '~/lib/support/server';

/**
 * GET /account with ACCOUNTS_ENABLED "1": the signed-in page. Orders and
 * addresses stay in Shopify customer accounts (SHOPIFY_CUSTOMER_ACCOUNT_URL,
 * unchanged); sign out posts to /account/logout. Signed out, it starts
 * sign-in. Flag off: the legacy Shopify redirect.
 */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Your account | OpenDrone'}, {name: 'robots', content: 'noindex, nofollow'}];

export async function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('', env);
  const session = await readSession(env.SUPPORT_DB, request);
  if (!session) throw redirect('/account/login?return_to=%2Faccount', {headers: {'Cache-Control': 'no-store'}});
  const headers = new Headers({'Cache-Control': 'no-store'});
  if (session.refreshCookie) headers.append('Set-Cookie', session.refreshCookie);
  return data({ordersUrl: customerAccountUrl(env), since: new Date(session.createdAt).toISOString().slice(0, 10)}, {headers});
}

export default function AccountRoute() {
  const {ordersUrl, since} = useLoaderData<typeof loader>();
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
