import {data, useLoaderData} from 'react-router';
import type {Route} from './+types/account.login';
import {accountsEnabled, safeReturnTo} from '~/lib/accounts/config';
import {identityProvider} from '~/lib/accounts/idp';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {startLogin} from '~/lib/accounts/signin';
import {supportHeaders} from '~/lib/support/server';

/**
 * GET /account/login?return_to=<path>: a notice first (signing in creates a
 * Shopify customer account holding the email address), then
 * `?go=1&return_to=` starts Shopify (or test IdP) sign-in. Legacy redirect
 * while ACCOUNTS_ENABLED is off.
 */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Sign in | OpenDrone'}, {name: 'robots', content: 'noindex, nofollow'}];

export function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('login', env);
  const url = new URL(request.url);
  if (url.searchParams.get('go') === '1') return startLogin(request, env, identityProvider(env, request));
  const returnTo = safeReturnTo(url.searchParams.get('return_to'));
  return data(
    {continueUrl: `/account/login?go=1&return_to=${encodeURIComponent(returnTo)}`, chatfpv: returnTo.startsWith('/oauth/')},
    {headers: {'Cache-Control': 'no-store'}},
  );
}

export default function AccountLoginRoute() {
  const {continueUrl, chatfpv} = useLoaderData<typeof loader>();
  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <h1 className="page-title">Sign in with your OpenDrone account</h1>
        <p className="page-description">
          {chatfpv ? 'chatfpv.com asked you to sign in. ' : ''}One account for opendrone.be and chatfpv.com.
        </p>
      </header>
      <div className="sp-narrow account-login">
        <section className="account-login-cta">
          <a href={continueUrl} className="od-btn od-btn-primary account-login-submit">
            Continue to sign in
          </a>
        </section>

        <details className="details-toggle">
          <summary className="details-toggle-summary">How sign-in and your data work</summary>
          <div className="details-toggle-body">
            <p>
              Shopify, which runs our shop, signs you in with a one-time code sent to your email address. If you have no customer account yet,
              signing in creates a Shopify customer account that holds your email address. We add nothing else to it: no newsletter or marketing
              consent, and no ChatFPV conversations.
            </p>
            <p>
              chatfpv.com receives a separate account id, never your name, email address or Shopify customer id. While you are signed in, your
              ChatFPV conversations are kept for 12 months after the last message; you can export or delete them on your account page at any time.
            </p>
            <p>
              Details: <a href="/privacy">privacy policy</a>.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
