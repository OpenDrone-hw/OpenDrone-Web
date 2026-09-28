import {redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/account.test-idp.authorize';
import {accountsEnabled, accountHeaders, sameOrigin, testIdpActive} from '~/lib/accounts/config';
import {IdpError} from '~/lib/accounts/idp';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {issueTestCode, TEST_CUSTOMERS} from '~/lib/accounts/test-idp';
import {supportHeaders} from '~/lib/support/server';

/**
 * Test identity provider form (staging E2E only). Active only with
 * ACCOUNTS_TEST_IDP "1" on a host that is not opendrone.be or
 * www.opendrone.be; 404 otherwise. Picks a test customer GID and returns
 * a 60-second signed code to /account/callback.
 */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () => [{title: 'Test sign-in | OpenDrone staging'}, {name: 'robots', content: 'noindex, nofollow'}];

function gate(request: Request, env: Env) {
  if (!accountsEnabled(env)) legacyAccountResponse('test-idp/authorize', env);
  if (!testIdpActive(env, request.url)) throw new Response('Not Found', {status: 404, headers: accountHeaders()});
}

export function loader({request, context}: Route.LoaderArgs) {
  gate(request, context.env);
  const q = new URL(request.url).searchParams;
  return {
    state: q.get('state') ?? '',
    nonce: q.get('nonce') ?? '',
    challenge: q.get('code_challenge') ?? '',
    redirectUri: q.get('redirect_uri') ?? '',
  };
}

export async function action({request, context}: Route.ActionArgs) {
  const {env} = context;
  gate(request, env);
  if (!sameOrigin(request)) throw new Response('Forbidden', {status: 403, headers: accountHeaders()});
  const form = await request.formData();
  const field = (k: string) => String(form.get(k) ?? '').trim();
  const custom = field('custom_gid');
  const gid = custom || field('gid');
  const redirectUri = field('redirect_uri');
  try {
    const code = await issueTestCode(env, new URL(request.url).origin, {gid, nonce: field('nonce'), challenge: field('code_challenge'), redirectUri});
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', field('state'));
    return redirect(target.toString(), {headers: {'Cache-Control': 'no-store'}});
  } catch (err) {
    throw new Response(err instanceof IdpError ? err.message : 'Bad request', {status: 400, headers: accountHeaders()});
  }
}

export default function TestIdpRoute() {
  const p = useLoaderData<typeof loader>();
  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <h1 className="page-title">Test sign-in</h1>
        <p className="page-description">Staging only. Pick a test customer; no Shopify account is used.</p>
      </header>
      <div className="sp-narrow">
        <form id="test-idp-form" method="post" className="sp-form">
          <input type="hidden" name="state" value={p.state} />
          <input type="hidden" name="nonce" value={p.nonce} />
          <input type="hidden" name="code_challenge" value={p.challenge} />
          <input type="hidden" name="redirect_uri" value={p.redirectUri} />
          {TEST_CUSTOMERS.map((gid, i) => (
            <label key={gid} className="sp-field">
              <input type="radio" name="gid" value={gid} defaultChecked={i === 0} /> {gid}
            </label>
          ))}
          <label className="sp-field">
            <span className="sp-label">Or another customer GID</span>
            <input name="custom_gid" className="sp-input" placeholder="gid://shopify/Customer/test-3" pattern="gid://shopify/Customer/[A-Za-z0-9_\-]{1,40}" />
          </label>
          <div className="sp-submit-row">
            <button type="submit" id="test-idp-submit" className="od-btn od-btn-primary">
              Sign in
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
