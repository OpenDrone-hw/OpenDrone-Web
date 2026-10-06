/** Wholesale applications are mailed to the company inbox through Resend.
 * Shopify Companies (B2B) is not available on the store's plan. No ordering
 * access, pricing or customer record is created by this module. */
import {sha256Hex} from './accounts/crypto.ts';
import {getCompanyIdentity} from './company.ts';

/** Countries eligible for retailer enquiries: the EU27 and United States. `vatPrefix` is the VIES
 *  prefix (EL for Greece), null outside the EU. */
export type TradeCountry = {code: string; name: string; vatPrefix: string | null};

const EU_TRADE: ReadonlyArray<[string, string]> = [
  ['AT', 'Austria'], ['BE', 'Belgium'], ['BG', 'Bulgaria'], ['HR', 'Croatia'],
  ['CY', 'Cyprus'], ['CZ', 'Czechia'], ['DK', 'Denmark'], ['EE', 'Estonia'],
  ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'],
  ['HU', 'Hungary'], ['IE', 'Ireland'], ['IT', 'Italy'], ['LV', 'Latvia'],
  ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MT', 'Malta'], ['NL', 'Netherlands'],
  ['PL', 'Poland'], ['PT', 'Portugal'], ['RO', 'Romania'], ['SK', 'Slovakia'],
  ['SI', 'Slovenia'], ['ES', 'Spain'], ['SE', 'Sweden'],
];

export const TRADE_COUNTRIES: readonly TradeCountry[] = [
  ...EU_TRADE.map(([code, name]) => ({code, name, vatPrefix: code === 'GR' ? 'EL' : code})),
  ...[['US', 'United States']].map(
    ([code, name]) => ({code, name, vatPrefix: null}),
  ),
];

export function tradeCountry(code: string): TradeCountry | undefined {
  return TRADE_COUNTRIES.find((c) => c.code === code);
}


export type TradeApplication = {
  company: string;
  contactName: string;
  email: string;
  country: TradeCountry;
  website: string;
  note: string;
};
export type TradeField = 'company' | 'contactName' | 'email' | 'country' | 'website' | 'note';
export type TradeValidation =
  | {ok: true; application: TradeApplication}
  | {ok: false; errors: Partial<Record<TradeField, string>>};

export function validateTradeApplication(form: Pick<FormData, 'get'>): TradeValidation {
  const errors: Partial<Record<TradeField, string>> = {};
  const read = (name: string) => typeof form.get(name) === 'string' ? String(form.get(name)).trim() : '';
  const company = read('company');
  const contactName = read('contactName');
  const email = read('email').toLowerCase();
  const note = read('note');
  const hasControl = (text: string) => [...text].some(char => char.charCodeAt(0) < 32);
  if (company.length < 2 || company.length > 200 || hasControl(company)) errors.company = 'Enter your company name.';
  if (!contactName || contactName.length > 100 || hasControl(contactName)) errors.contactName = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.email = 'Enter a valid email address.';
  const country = tradeCountry(read('country').toUpperCase());
  if (!country) errors.country = 'Choose a country from the list.';
  if (note.length > 2000) errors.note = 'Keep your message under 2,000 characters.';
  let website = read('site');
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    try {
      const url = new URL(website);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.') || url.username || url.password || website.length > 300) throw new Error('invalid');
      website = url.toString();
    } catch { errors.website = 'Enter your shop website, or leave it empty.'; }
  }
  if (Object.keys(errors).length || !country) return {ok: false, errors};
  return {ok: true, application: {company, contactName, email, country, website, note}};
}

export type TradeEnv = {
  TRADE_MAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_EMAIL?: string;
};
export function tradeConfigured(env: TradeEnv): boolean {
  return env.TRADE_MAIL_ENABLED === '1' && Boolean(env.RESEND_API_KEY);
}

export type ApplicationResult = {ok: true} | {ok: false; reason: 'not_configured' | 'unavailable'};

export function applicationMail(application: TradeApplication): {subject: string; text: string} {
  return {
    subject: `Wholesale application: ${application.company} (${application.country.code})`,
    text: [
      'Wholesale application from https://opendrone.be/wholesale',
      'Contact details are applicant-supplied and unverified. Reply to answer the applicant.',
      '',
      `Company: ${application.company}`,
      `Contact: ${application.contactName}`,
      `Email: ${application.email}`,
      `Country: ${application.country.name} (${application.country.code})`,
      application.website ? `Shop website: ${application.website}` : '',
      application.note ? `\nMessage:\n${application.note}` : '',
    ].filter(Boolean).join('\n'),
  };
}

/** Mails one application to the company inbox, reply-to the applicant. The
 * idempotency key makes a retry of the same application within 24 hours a
 * no-op at Resend, so an unknown result can be retried by the applicant. */
export async function submitTradeApplication(
  env: TradeEnv,
  application: TradeApplication,
  fetcher: typeof fetch = fetch,
): Promise<ApplicationResult> {
  if (!tradeConfigured(env)) return {ok: false, reason: 'not_configured'};
  const key = `wholesale-${await sha256Hex(JSON.stringify([
    application.email, application.company.toLowerCase().replace(/\s+/g, ' '), application.country.code,
  ]))}`;
  const mail = applicationMail(application);
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        from: `OpenDrone wholesale <${env.SUPPORT_FROM_EMAIL || 'support@opendrone.be'}>`,
        to: [getCompanyIdentity(env as Record<string, string | undefined>).email],
        reply_to: application.email,
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn('[wholesale] application mail not sent', res.status);
    return res.ok ? {ok: true} : {ok: false, reason: 'unavailable'};
  } catch {
    console.warn('[wholesale] application mail failed');
    return {ok: false, reason: 'unavailable'};
  }
}
