/** Wholesale applications are mailed to the company inbox through Resend.
 * Shopify Companies (B2B) is not available on the store's plan. No ordering
 * access, pricing or customer record is created by this module. */
import {sha256Hex} from './accounts/crypto.ts';
import {getCompanyIdentity} from './company.ts';

/** Any country may apply; staff decide per application. ISO 3166-1 alpha-2
 *  plus Kosovo (XK), named in English and sorted by name. */
export type TradeCountry = {code: string; name: string};

const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

const REGION_NAMES = new Intl.DisplayNames('en', {type: 'region'});

export const TRADE_COUNTRIES: readonly TradeCountry[] = COUNTRY_CODES
  .map((code) => ({code, name: REGION_NAMES.of(code) ?? code}))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

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
