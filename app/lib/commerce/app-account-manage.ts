/**
 * What a signed-in customer changes on My account in app mode: the name, the email address (a code to the new address
 * first), and, in the next step of this page, preferences and the delete request. Each is one typed operation of the app
 * (`storefront.account_profile`, `storefront.account_email`); this file only checks the same-origin POST, reads the session
 * token from the cookie and says in one sentence what went wrong. The app decides everything else.
 */
import {appOp, AppUnavailable, edgeCache, snapshot, type AppCatalog, type Quote} from './app-api.ts';
import {postOk, readSessionToken, type AccountEnv} from './app-account.ts';

export type ManageResult = {intent: string; ok: boolean; step: 'idle' | 'code'; email: string; problem: string | null};

const DOWN = 'Your account cannot be reached right now. Try again in a minute.';
const RELOAD = 'Something went wrong. Reload the page and try again.';
const SIGNED_OUT = 'You are signed out. Sign in again.';

type Out = {ok: boolean; error?: {code: string; detail: string}};

/** The one sentence for a refusal of the app; the app's own words only for the codes whose words are for a customer. */
export function problemOf(out: Out, fallback: string): string | null {
  if (out.ok) return null;
  switch (out.error?.code) {
    case 'unauthenticated':
      return SIGNED_OUT;
    case 'invalid_code':
      return 'That code did not work. It may have expired or been used. Ask for a new one.';
    case 'taken':
      return 'That address already has its own account. Sign in with it instead.';
    case 'invalid':
      return out.error.detail || fallback;
    default:
      return fallback;
  }
}

/** POST /account/profile: `intent` is name, email (mail the code) or email-confirm (spend it). */
export async function profileRoute(request: Request, env: AccountEnv): Promise<ManageResult> {
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? '').trim();
  const intent = f('intent');
  const email = f('new_email').toLowerCase();
  const fail = (problem: string, step: ManageResult['step'] = 'idle'): ManageResult => ({intent, ok: false, step, email, problem});
  if (!postOk(request)) return fail(RELOAD);
  const token = await readSessionToken(request, env);
  if (!token) return fail(SIGNED_OUT);
  try {
    if (intent === 'name') {
      if (f('name').length > 120) return fail('Use at most 120 characters.');
      const out = await appOp(env, 'storefront.account_profile', {session: token, name: f('name')});
      return out.ok ? {intent, ok: true, step: 'idle', email: '', problem: null} : fail(problemOf(out, 'We could not save your name.') ?? '');
    }
    if (intent !== 'email' && intent !== 'email-confirm') return fail(RELOAD);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return fail('Enter a valid email address.');
    const code = f('code').replace(/\s/g, '');
    if (intent === 'email-confirm' && !/^[0-9]{6}$/.test(code)) return fail('Enter the 6 digits from the mail.', 'code');
    const out = await appOp(env, 'storefront.account_email', {session: token, new_email: email, ...(intent === 'email-confirm' ? {code} : {})});
    if (!out.ok) return fail(problemOf(out, 'We could not change your email address.') ?? '', intent === 'email-confirm' && out.error?.code !== 'taken' ? 'code' : 'idle');
    return intent === 'email' ? {intent, ok: true, step: 'code', email, problem: null} : {intent, ok: true, step: 'idle', email, problem: null};
  } catch (err) {
    if (err instanceof AppUnavailable) return fail(DOWN, intent === 'email-confirm' ? 'code' : 'idle');
    throw err;
  }
}

/** The countries the shop delivers to (the checkout's own list), so a saved address can be used at checkout. */
export async function shipCountries(env: AccountEnv): Promise<string[]> {
  try {
    // The app lists the countries with any quote, so price one unit of the first variant for the list.
    const cat = await snapshot<AppCatalog>(env, 'storefront.catalog', edgeCache());
    const variant = cat.products.flatMap((p) => p.variants).find((v) => v.available)?.id;
    if (!variant) return ['BE'];
    const out = await appOp<Quote>(env, 'storefront.quote', {lines: [{variant, qty: 1}], country: 'BE'});
    return out.data?.ship_countries?.length ? out.data.ship_countries : ['BE'];
  } catch {
    return ['BE'];
  }
}
