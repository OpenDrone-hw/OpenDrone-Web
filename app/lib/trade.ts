/** Wholesale applications are mailed to the company inbox through Resend.
 * Shopify Companies (B2B) is not available on the store's plan. No ordering
 * access, pricing or customer record is created by this module. */
import {sha256Hex} from './accounts/crypto.ts';
import {getCompanyIdentity} from './company.ts';
import {titleWithoutBatch} from './catalog.ts';
import {approveUrl, normaliseVat, signApproval} from './wholesale-approve-token.ts';

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


/** One orderable SKU on the form: the live catalog's OpenDrone variants, the
 *  SKUs the wholesale codes cover (`sku:OPEN*`, `scripts/wholesale_lib.py`).
 *  The form posts `qty_<sku>`. Motors count per motor. */
export type TradeProduct = {sku: string; product: string; variant: string};
export type TradeProductGroup = {product: string; items: TradeProduct[]};

const WHOLESALE_SKU = /^OPEN[A-Z0-9-]*$/;

/** The SKUs a retailer can ask for, grouped per product in catalog order. One
 *  entry per SKU: the Buy now and Pre-order lanes of a board share it. */
export function tradeProducts(catalog: {products: ReadonlyArray<{title: string; variants: ReadonlyArray<{sku: string; title: string}>}>}): TradeProductGroup[] {
  const seen = new Set<string>();
  const groups: TradeProductGroup[] = [];
  for (const product of catalog.products) {
    const items: TradeProduct[] = [];
    for (const variant of product.variants) {
      const sku = variant.sku?.trim().toUpperCase();
      if (!sku || !WHOLESALE_SKU.test(sku) || seen.has(sku)) continue;
      seen.add(sku);
      const title = variant.title && variant.title !== 'Default Title' ? titleWithoutBatch(variant.title) : '';
      items.push({sku, product: product.title, variant: title});
    }
    if (items.length) groups.push({product: product.title, items});
  }
  return groups;
}

export function tradeProductName(item: TradeProduct): string {
  return item.variant ? `${item.product} ${item.variant}` : item.product;
}

export const SHOP_TYPES = ['online', 'physical', 'both', 'distributor'] as const;
export const ORDER_RHYTHMS = ['once', 'monthly', 'quarterly', 'unsure'] as const;
const SHOP_TYPE_LABEL: Record<(typeof SHOP_TYPES)[number], string> = {
  online: 'Online shop', physical: 'Physical shop', both: 'Online and physical shop', distributor: 'Distributor',
};
const RHYTHM_LABEL: Record<(typeof ORDER_RHYTHMS)[number], string> = {
  once: 'One order to start', monthly: 'Monthly', quarterly: 'Quarterly', unsure: 'Not sure yet',
};
const MAX_QTY = 100000;

export type TradeApplication = {
  company: string;
  contactName: string;
  email: string;
  country: TradeCountry;
  website: string;
  note: string;
  taxId: string;
  shopType: (typeof SHOP_TYPES)[number];
  rhythm: (typeof ORDER_RHYTHMS)[number] | '';
  /** Estimated units per order, only for SKUs with a quantity above zero. */
  quantities: Array<{sku: string; name: string; qty: number}>;
};
export type TradeField = 'company' | 'contactName' | 'email' | 'country' | 'website' | 'note' | 'taxId' | 'shopType' | 'quantities' | 'rhythm';
export type TradeValidation =
  | {ok: true; application: TradeApplication}
  | {ok: false; errors: Partial<Record<TradeField, string>>};

export function validateTradeApplication(form: Pick<FormData, 'get'>, products: readonly TradeProductGroup[]): TradeValidation {
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
  const taxId = read('taxId').toUpperCase();
  if (taxId && !/^[A-Z0-9][A-Z0-9 .\-/]{1,29}$/.test(taxId)) errors.taxId = 'Enter a VAT or tax ID with letters and numbers only, or leave it empty.';
  const shopType = SHOP_TYPES.find((type) => type === read('shopType'));
  if (!shopType) errors.shopType = 'Choose what kind of business you are.';
  const rhythmValue = read('rhythm');
  const rhythm = rhythmValue ? ORDER_RHYTHMS.find((value) => value === rhythmValue) : '';
  if (rhythm === undefined) errors.rhythm = 'Choose how often you expect to order.';
  const quantities: TradeApplication['quantities'] = [];
  for (const item of products.flatMap((group) => group.items)) {
    const raw = read(`qty_${item.sku}`);
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || Number(raw) > MAX_QTY) { errors.quantities = 'Enter whole numbers for quantities.'; continue; }
    if (Number(raw) > 0) quantities.push({sku: item.sku, name: tradeProductName(item), qty: Number(raw)});
  }
  if (!errors.quantities && !quantities.length) errors.quantities = 'Enter a quantity for at least one product.';
  if (Object.keys(errors).length || !country || !shopType || rhythm === undefined) return {ok: false, errors};
  return {ok: true, application: {company, contactName, email, country, website, note, taxId, shopType, rhythm, quantities}};
}

export type TradeEnv = {
  TRADE_MAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_EMAIL?: string;
  /** Signs the "Review and approve" link (wholesale-approve-token.ts); without it the mail has the command only. */
  WHOLESALE_APPROVE_SECRET?: string;
};
export function tradeConfigured(env: TradeEnv): boolean {
  return env.TRADE_MAIL_ENABLED === '1' && Boolean(env.RESEND_API_KEY);
}

export type ApplicationResult = {ok: true} | {ok: false; reason: 'not_configured' | 'unavailable'};

/** Single-quoted for a POSIX shell: the applicant's text can never break out. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The staff command that onboards this applicant (`docs/wholesale.md`). */
export function onboardCommand(application: TradeApplication): string {
  const parts = ['python3 scripts/wholesale-onboard.py', '--email', shellQuote(application.email), '--country', application.country.code];
  const vat = normaliseVat(application.taxId);
  if (vat) parts.push('--vat', shellQuote(vat));
  parts.push('--company', shellQuote(application.company));
  return parts.join(' ');
}

/** The signed staff link for this applicant, or null without WHOLESALE_APPROVE_SECRET. */
export async function approveLink(env: TradeEnv, application: TradeApplication, origin: string, now = new Date()): Promise<string | null> {
  const token = await signApproval(env.WHOLESALE_APPROVE_SECRET, {
    email: application.email, country: application.country.code, vat: application.taxId,
    company: application.company, contact: application.contactName,
  }, now);
  return token ? approveUrl(origin, token) : null;
}

export function applicationMail(application: TradeApplication, approve: string | null = null): {subject: string; text: string} {
  return {
    subject: `Wholesale application: ${application.company} (${application.country.code}, ${application.quantities.reduce((sum, {qty}) => sum + qty, 0)} units)`,
    text: [
      'Wholesale application from https://opendrone.be/wholesale',
      'Contact details are applicant-supplied and unverified. Reply to answer the applicant.',
      '',
      `Company: ${application.company}`,
      `Contact: ${application.contactName}`,
      `Email: ${application.email}`,
      `Country: ${application.country.name} (${application.country.code})`,
      `Business: ${SHOP_TYPE_LABEL[application.shopType]}`,
      application.taxId ? `VAT / tax ID: ${application.taxId}` : 'VAT / tax ID: not given',
      application.website ? `Shop website: ${application.website}` : '',
      '',
      'Estimated quantity per order:',
      ...application.quantities.map(({sku, name, qty}) => `  ${qty} x ${name} (${sku})`),
      application.rhythm ? `Order rhythm: ${RHYTHM_LABEL[application.rhythm]}` : '',
      application.note ? `\nMessage:\n${application.note}` : '',
      '',
      approve ? `Review and approve (staff only, link valid 30 days, opening it writes nothing):\n  ${approve}\n` : '',
      approve ? 'Fallback by hand (dry run first, then add --apply):' : 'Onboard after approval (dry run first, then add --apply):',
      `  ${onboardCommand(application)}`,
    ].filter(Boolean).join('\n'),
  };
}

/** Mails one application to the company inbox, reply-to the applicant. The
 * idempotency key is the application as typed, so a retry of the same
 * application within 24 hours is a no-op at Resend and an unknown result can
 * be retried by the applicant; a changed application is a new mail. The
 * approve link is left out of the key: its expiry differs on every submit, and
 * Resend answers 409 when one key carries another body, which for the same
 * application means it was already sent. */
export async function submitTradeApplication(
  env: TradeEnv,
  application: TradeApplication,
  fetcher: typeof fetch = fetch,
  origin = 'https://opendrone.be',
): Promise<ApplicationResult> {
  if (!tradeConfigured(env)) return {ok: false, reason: 'not_configured'};
  const typed = applicationMail(application);
  const key = `wholesale-${await sha256Hex(JSON.stringify([application.email.toLowerCase(), typed.subject, typed.text]))}`;
  const mail = applicationMail(application, await approveLink(env, application, origin));
  const sent = await sendTradeMail(env, {
    to: [companyInbox(env)], replyTo: application.email, subject: mail.subject, text: mail.text, key, repeatIsSent: true,
  }, fetcher);
  if (!sent) console.warn('[wholesale] application mail not sent');
  return sent ? {ok: true} : {ok: false, reason: 'unavailable'};
}

export function companyInbox(env: TradeEnv): string {
  return getCompanyIdentity(env as Record<string, string | undefined>).email;
}

/** One plain-text mail through Resend from the wholesale sender. The
 *  idempotency key makes a retry within 24 hours a no-op at Resend. True when
 *  Resend accepted it. */
export async function sendTradeMail(
  env: TradeEnv,
  mail: {to: string[]; replyTo: string; bcc?: string[]; subject: string; text: string; key: string; repeatIsSent?: boolean},
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': mail.key,
      },
      body: JSON.stringify({
        from: `OpenDrone wholesale <${env.SUPPORT_FROM_EMAIL || 'support@opendrone.be'}>`,
        to: mail.to,
        reply_to: mail.replyTo,
        ...(mail.bcc?.length ? {bcc: mail.bcc} : {}),
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok || (Boolean(mail.repeatIsSent) && res.status === 409);
  } catch {
    return false;
  }
}
