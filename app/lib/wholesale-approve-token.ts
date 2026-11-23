/**
 * The signed "Review and approve" link in a wholesale application mail.
 *
 * The link carries the application (email, country, VAT, company, contact,
 * language) as base64url JSON, signed with HMAC-SHA256 under the Worker
 * secret WHOLESALE_APPROVE_SECRET, and expires after APPROVE_TTL_DAYS. The
 * signature is the only authority: whoever holds a valid link can review and
 * approve that one application, nothing else. Server only.
 */
import {b64urlText, hmacB64url, safeEqual, textFromB64url} from './accounts/crypto.ts';

export const APPROVE_TTL_DAYS = 30;
export const APPROVE_PATH = '/wholesale/approve';
const DOMAIN = 'wholesale-approve.v1';

export type ApprovalPayload = {
  v: 1;
  email: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** As in onboardCommand: upper case, spaces, dots, dashes and slashes removed; '' when not given. */
  vat: string;
  company: string;
  contact: string;
  /** Welcome mail language: Dutch for BE and NL, English otherwise. */
  lang: 'en' | 'nl';
  /** Expiry, Unix seconds. */
  exp: number;
};

export type ApprovalApplication = Omit<ApprovalPayload, 'v' | 'exp' | 'lang'>;

export function approvalLanguage(country: string): 'en' | 'nl' {
  return country === 'BE' || country === 'NL' ? 'nl' : 'en';
}

export function normaliseVat(raw: string): string {
  return raw.replace(/[\s.\-/]/g, '').toUpperCase();
}

function usable(secret: string | undefined): secret is string {
  return Boolean(secret && secret.trim().length >= 16);
}

export async function signApproval(secret: string | undefined, app: ApprovalApplication, now = new Date()): Promise<string | null> {
  if (!usable(secret)) return null;
  const payload: ApprovalPayload = {
    v: 1,
    email: app.email.trim().toLowerCase(),
    country: app.country.trim().toUpperCase(),
    vat: normaliseVat(app.vat),
    company: app.company,
    contact: app.contact,
    lang: approvalLanguage(app.country.trim().toUpperCase()),
    exp: Math.floor(now.getTime() / 1000) + APPROVE_TTL_DAYS * 86400,
  };
  const body = b64urlText(JSON.stringify(payload));
  return `${body}.${await hmacB64url(secret.trim(), `${DOMAIN}|${body}`)}`;
}

export function approveUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${APPROVE_PATH}?t=${encodeURIComponent(token)}`;
}

export type ApprovalCheck = {ok: true; payload: ApprovalPayload} | {ok: false; status: 403 | 410};

const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;

/** 403 for a missing secret, an unsigned, malformed or tampered token; 410 for a valid but expired one. */
export async function verifyApproval(secret: string | undefined, token: string | null | undefined, now = new Date()): Promise<ApprovalCheck> {
  if (!usable(secret) || !token || token.length > 4096) return {ok: false, status: 403};
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return {ok: false, status: 403};
  const [body, sig] = parts;
  if (!safeEqual(sig, await hmacB64url(secret.trim(), `${DOMAIN}|${body}`))) return {ok: false, status: 403};
  let p: Partial<ApprovalPayload>;
  try {
    p = JSON.parse(textFromB64url(body)) as Partial<ApprovalPayload>;
  } catch {
    return {ok: false, status: 403};
  }
  const valid =
    p && p.v === 1 && str(p.email, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) &&
    str(p.country, 2) && /^[A-Z]{2}$/.test(p.country) && str(p.vat, 30) && /^[A-Z0-9]*$/.test(p.vat) &&
    str(p.company, 200) && str(p.contact, 100) && (p.lang === 'en' || p.lang === 'nl') &&
    typeof p.exp === 'number' && Number.isFinite(p.exp);
  if (!valid) return {ok: false, status: 403};
  if (Math.floor(now.getTime() / 1000) > p.exp!) return {ok: false, status: 410};
  return {ok: true, payload: p as ApprovalPayload};
}
