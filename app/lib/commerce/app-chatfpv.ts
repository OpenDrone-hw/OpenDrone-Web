/**
 * ChatFPV for a signed-in customer in app mode. Production derives ChatFPV's pairwise account id from the Shopify customer id;
 * here the same derivation runs over the app's opaque customer id (`storefront.account` `customer_id`, which an email change
 * never moves), so one customer is one ChatFPV account. Needs ACCOUNT_PAIRWISE_SALT; the widget assertion needs
 * WIDGET_ASSERTION_KEY and history export or delete CHATFPV_KEY with the ChatFPV origin. Without them each answers "not connected".
 * Not here: the chatfpv.com sign-in with OAuth (`/oauth/authorize`, a `sid` per session) still needs the D1 account and session
 * tables that app mode does not use.
 */
import {accountHeaders} from '../accounts/config.ts';
import {pairwiseSub} from '../accounts/crypto.ts';
import {signAssertion} from '../accounts/assertion.ts';
import {chatFpvErase, chatFpvExport, type RightsEnv, type HistoryNotice} from '../accounts/rights.ts';
import {chatFpvOrigin} from '../support/chatfpv.ts';
import {postOk, readAccount, type AccountEnv} from './app-account.ts';

type Env = AccountEnv & RightsEnv & {WIDGET_ASSERTION_KEY?: string};

export const chatFpvConnected = (env: Pick<Env, 'ACCOUNT_PAIRWISE_SALT' | 'CHATFPV_KEY' | 'CHATFPV_URL'>): boolean =>
  Boolean(env.ACCOUNT_PAIRWISE_SALT && env.CHATFPV_KEY && chatFpvOrigin(env));

/** The ChatFPV account id of the signed-in customer, or null (signed out, no id yet, or no salt). */
export async function appChatFpvSub(request: Request, env: Env, fetcher?: typeof fetch): Promise<string | null> {
  if (!env.ACCOUNT_PAIRWISE_SALT) return null;
  const {account} = await readAccount(request, env, fetcher);
  return account?.customer_id ? pairwiseSub(env.ACCOUNT_PAIRWISE_SALT, `app-customer:${account.customer_id}`) : null;
}

/** GET /api/account/widget-assertion in app mode: 5 minutes, 204 when signed out or not connected. */
export async function appWidgetAssertion(request: Request, env: Env, fetcher?: typeof fetch, now = Date.now()): Promise<Response> {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return new Response(null, {status: 403, headers: accountHeaders()});
  const sub = env.WIDGET_ASSERTION_KEY ? await appChatFpvSub(request, env, fetcher) : null;
  if (!sub || !env.WIDGET_ASSERTION_KEY) return new Response(null, {status: 204, headers: accountHeaders()});
  return new Response(JSON.stringify(await signAssertion(env.WIDGET_ASSERTION_KEY, sub, Math.floor(now / 1000))), {headers: accountHeaders({'Content-Type': 'application/json'})});
}

const back = (notice: HistoryNotice) => new Response(null, {status: 303, headers: accountHeaders({Location: `/account?chatfpv=${notice}#privacy`})});

/** POST /account/chatfpv-history in app mode: export the history as JSON, or delete it with `confirm=yes`. */
export async function appHistory(request: Request, env: Env, fetcher?: typeof fetch, now = Date.now()): Promise<Response> {
  if (!postOk(request)) return new Response('Forbidden', {status: 403, headers: accountHeaders()});
  const form = await request.formData().catch(() => null);
  const intent = form?.get('intent');
  if (intent !== 'export' && intent !== 'delete') return new Response('Bad Request', {status: 400, headers: accountHeaders()});
  const sub = await appChatFpvSub(request, env);
  if (!sub) return back('unavailable');
  if (intent === 'export') {
    const result = await chatFpvExport(env, sub, fetcher);
    if (!result.ok) return back('unavailable');
    return new Response(JSON.stringify(result.body, null, 2), {
      headers: accountHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="chatfpv-history-${new Date(now).toISOString().slice(0, 10)}.json"`,
      }),
    });
  }
  if (form?.get('confirm') !== 'yes') return back('confirm');
  return back((await chatFpvErase(env, sub, fetcher)).ok ? 'deleted' : 'unavailable');
}
