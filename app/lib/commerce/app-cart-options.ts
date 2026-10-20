/**
 * The buyer's cart choices that are not lines: the discount code they applied and whether they collect the order.
 * Kept in a signed cookie beside the cart so they survive a country change or a reload; the app prices them
 * (`storefront.quote`), nothing is computed here.
 */
import {createCookie} from 'react-router';
import type {AppEnv} from './app-api.ts';

export type CartOptions = {code: string; pickup: boolean};

export const NO_OPTIONS: CartOptions = {code: '', pickup: false};

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

/** Options from untrusted input: a code of letters, digits, - and _ (as the app accepts), a boolean. */
export function cleanOptions(raw: unknown): CartOptions {
  const o = (raw ?? {}) as {code?: unknown; pickup?: unknown};
  const code = typeof o.code === 'string' ? o.code.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  return {code, pickup: o.pickup === true};
}

export async function readOptions(request: Request, env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<CartOptions> {
  return cleanOptions(await optionsCookie(env).parse(request.headers.get('Cookie')));
}

export async function writeOptions(options: CartOptions, env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<string> {
  return optionsCookie(env).serialize(cleanOptions(options));
}
