/**
 * The newsletter in app mode (COMMERCE_SOURCE=app, website-parity row 13): consent lives in the app as an owned
 * subscriber record, so signup and unsubscribe need no Shopify Admin token. Same answers as
 * app/lib/growth/shopify-newsletter.ts, so the two routes branch only on where the consent is written.
 *
 * The site keeps what it owned: the honeypot, Turnstile, the rate limits, the welcome mail and the signed link of its
 * mails. The app keeps consent (state, source, time) and never clears an unsubscribe on a later signup. The country is
 * sent only when it is not sold direct (the Shopify path's `country-<CODE>` tag rule), so the app remembers who to tell
 * when sales open there.
 */
import {notSoldDirect} from '../shipping-rates.ts';
import {appOp, type AppEnv} from './app-api.ts';

export type AppSubscribeResult = 'subscribed' | 'pending' | 'already-subscribed' | 'suppressed' | 'failed';

/** Record the signup in the app. An unreachable app, a refusal or the flag being off is `failed`: the signup is never faked. */
export async function subscribeWithApp(
  env: AppEnv,
  email: string,
  productHandle?: string,
  country?: string | null,
  fetcher: typeof fetch = fetch,
  confirmUrl?: string,
): Promise<AppSubscribeResult> {
  const remembered = country && ['shops', 'closed'].includes(notSoldDirect(country) ?? '') ? country.trim().toUpperCase() : undefined;
  try {
    const out = await appOp<{result: string}>(env, 'storefront.newsletter_subscribe', {
      email,
      ...(productHandle ? {product: productHandle} : {}),
      ...(remembered ? {country: remembered} : {}),
      source: 'site',
      ...(confirmUrl ? {link_base: confirmUrl} : {}),
    }, fetcher);
    if (!out.ok) return 'failed';
    const result = out.data?.result;
    return result === 'subscribed' ? 'subscribed' : result === 'pending' ? 'pending' : result === 'already_subscribed' ? 'already-subscribed' : result === 'suppressed' ? 'suppressed' : 'failed';
  } catch {
    return 'failed';
  }
}

export type AppConfirmResult = 'confirmed' | 'already-confirmed' | 'suppressed' | 'invalid' | 'expired' | 'failed';

/** Confirm a double opt-in signup with the token of the mailed link. A refused token is `invalid` or `expired`, never a success. */
export async function confirmWithApp(env: AppEnv, token: string, fetcher: typeof fetch = fetch): Promise<AppConfirmResult> {
  try {
    const out = await appOp<{result: string}>(env, 'storefront.newsletter_confirm', {token, source: 'site'}, fetcher);
    if (!out.ok) return out.error?.code === 'invalid_token' ? 'invalid' : out.error?.code === 'expired' ? 'expired' : 'failed';
    const r = out.data?.result;
    return r === 'confirmed' ? 'confirmed' : r === 'already_confirmed' ? 'already-confirmed' : r === 'suppressed' ? 'suppressed' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Withdraw consent in the app. An address the app does not know is the same success, so nothing here confirms who is listed. */
export async function unsubscribeWithApp(env: AppEnv, email: string, fetcher: typeof fetch = fetch): Promise<'unsubscribed' | 'failed'> {
  try {
    const out = await appOp<{result: string}>(env, 'storefront.newsletter_unsubscribe', {email, source: 'site'}, fetcher);
    return out.ok && out.data?.result === 'unsubscribed' ? 'unsubscribed' : 'failed';
  } catch {
    return 'failed';
  }
}
