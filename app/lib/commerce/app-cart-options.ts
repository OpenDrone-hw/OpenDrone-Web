/**
 * The buyer's cart choices that are not lines: the discount code they applied and whether they collect the order.
 * Kept in a signed cookie beside the cart so they survive a country change or a reload; the app prices them
 * (`storefront.quote`), nothing is computed here.
 */
import {createCookie} from 'react-router';
import type {AppEnv} from './app-api.ts';

/** The first-touch keys an app order may carry and the longest value: the app's own list and limit
 *  (incutec-app server/attribution.py ATTRIBUTE_KEYS, MAX_VALUE). */
export const ATTRIBUTE_KEYS = ['_utm_source', '_utm_medium', '_utm_campaign', '_utm_content', '_ref', '_referrer', '_landing'] as const;
export const ATTRIBUTE_MAX = 200;

export type CartOptions = {code: string; pickup: boolean; attributes: Record<string, string>};

export const NO_OPTIONS: CartOptions = {code: '', pickup: false, attributes: {}};

/** Attributes from untrusted input, validated as the app does: only the allowed keys, plain text of at most 200
 *  characters without control characters, blanks dropped. A bad entry is dropped, never sent (the app would refuse
 *  the whole checkout). */
export function cleanAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of ATTRIBUTE_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== 'string') continue;
    const value = v.trim();
    // eslint-disable-next-line no-control-regex
    if (!value || v.length > ATTRIBUTE_MAX || /[\u0000-\u001f\u007f]/.test(v)) continue;
    out[key] = value;
  }
  return out;
}

export function optionsCookie(env: Pick<AppEnv, 'SESSION_SECRET'>) {
  return createCookie('od_app_cart_options', {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: true,
    secrets: [env.SESSION_SECRET],
    maxAge: 60 * 60 * 24 * 14,
  });
}

/** Options from untrusted input: a code of letters, digits, - and _ (as the app accepts), a boolean, the attribution attributes. */
export function cleanOptions(raw: unknown): CartOptions {
  const o = (raw ?? {}) as {code?: unknown; pickup?: unknown; attributes?: unknown};
  const code = typeof o.code === 'string' ? o.code.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return {code, pickup: o.pickup === true, attributes: cleanAttributes(o.attributes)};
}

export async function readOptions(request: Request, env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<CartOptions> {
  return cleanOptions(await optionsCookie(env).parse(request.headers.get('Cookie')));
}

export async function writeOptions(options: CartOptions, env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<string> {
  return optionsCookie(env).serialize(cleanOptions(options));
}
