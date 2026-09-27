/**
 * Browser side of the widget assertion (accounts contract "Widget
 * assertion"): fetch it same-origin, post it to the ChatFPV iframe with the
 * exact ChatFPV origin as targetOrigin (never "*"), refresh before expiry.
 * Browser-safe: no server imports.
 */

export type WidgetAssertion = {assertion: string; exp: number};

const ASSERTION = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The assertion for the signed-in shopper, or null (signed out: 204, or any failure). */
export async function fetchWidgetAssertion(fetcher: typeof fetch = fetch): Promise<WidgetAssertion | null> {
  try {
    const res = await fetcher('/api/account/widget-assertion', {credentials: 'same-origin', headers: {Accept: 'application/json'}, cache: 'no-store'});
    if (res.status !== 200) return null;
    const body = (await res.json()) as Partial<WidgetAssertion>;
    return typeof body.assertion === 'string' && ASSERTION.test(body.assertion) && typeof body.exp === 'number'
      ? {assertion: body.assertion, exp: body.exp}
      : null;
  } catch {
    return null;
  }
}

/** The exact origin of the iframe src, or null. */
export function frameOrigin(src: string): string | null {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost') ? u.origin : null;
  } catch {
    return null;
  }
}

/** postMessage({type:"chatfpv:assertion", assertion}, <exact ChatFPV origin>). */
export function postAssertion(target: Pick<Window, 'postMessage'> | null, src: string, assertion: string): boolean {
  const origin = frameOrigin(src);
  if (!target || !origin) return false;
  target.postMessage({type: 'chatfpv:assertion', assertion}, origin);
  return true;
}

/** Refresh one minute before `exp` (epoch seconds), at least 30 s from now. */
export function refreshDelayMs(exp: number, now = Date.now()): number {
  return Math.max(30_000, exp * 1000 - now - 60_000);
}
