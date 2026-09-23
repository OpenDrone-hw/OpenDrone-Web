/**
 * Trade orders: a shop asks for a proforma invoice through /wholesale instead
 * of using the consumer checkout. This module holds what the page sells, the
 * request validation, the email to the shop inbox and the lead time read from
 * `content/preorders.json`.
 *
 * Mail goes through Resend with the same variables as the withdrawal form
 * (`RESEND_API_KEY`, `SUPPORT_FROM_EMAIL`, `PUBLIC_COMPANY_EMAIL`). Without a
 * key nothing is sent and the result says so, so the page never tells a shop
 * its request arrived when it did not.
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it.
 */

import {campaignDate, latestShipDate, type CampaignConfig} from './preorder-campaign.ts';

/** What a shop can order. The FC, ESC, receiver and motors are not sold to
 *  trade; the ESC joins once a customs broker has classified it. */
export type TradeGroup = 'frame' | 'strap';

export type TradeSku = {sku: string; group: TradeGroup; label: string};

export const TRADE_SKUS: readonly TradeSku[] = [
  {sku: 'OPENFRAME-5', group: 'frame', label: 'OpenFrame 5" Freestyle'},
  {sku: 'OPENFRAME-3', group: 'frame', label: 'OpenFrame 3" Freestyle'},
  {sku: 'ACC-FRM-ARM-5', group: 'frame', label: 'OpenFrame spare: arm, 5"'},
  {sku: 'ACC-FRM-ARM-3', group: 'frame', label: 'OpenFrame spare: arm, 3"'},
  {sku: 'ACC-FRM-TOP-5', group: 'frame', label: 'OpenFrame spare: top plate, 5"'},
  {sku: 'ACC-FRM-TOP-3', group: 'frame', label: 'OpenFrame spare: top plate, 3"'},
  {sku: 'ACC-FRM-MID-5', group: 'frame', label: 'OpenFrame spare: middle plate, 5"'},
  {sku: 'ACC-FRM-MID-3', group: 'frame', label: 'OpenFrame spare: middle plate, 3"'},
  {sku: 'ACC-FRM-BOT-5', group: 'frame', label: 'OpenFrame spare: bottom plate, 5"'},
  {sku: 'ACC-FRM-BOT-3', group: 'frame', label: 'OpenFrame spare: bottom plate, 3"'},
  {sku: 'ACC-FRM-CROSS-5', group: 'frame', label: 'OpenFrame spare: cross, 5"'},
  {sku: 'ACC-FRM-CROSS-3', group: 'frame', label: 'OpenFrame spare: cross, 3"'},
  {sku: 'ACC-FRM-CAM-5', group: 'frame', label: 'OpenFrame spare: camera mount pair, 5"'},
  {sku: 'ACC-FRM-CAM-3', group: 'frame', label: 'OpenFrame spare: camera mount pair, 3"'},
  {sku: 'ACC-FRM-TPU-5', group: 'frame', label: 'OpenFrame spare: TPU parts set, 5"'},
  {sku: 'ACC-FRM-TPU-3', group: 'frame', label: 'OpenFrame spare: TPU parts set, 3"'},
  {sku: 'ACC-FRM-HW-5', group: 'frame', label: 'OpenFrame spare: hardware kit, 5"'},
  {sku: 'ACC-FRM-HW-3', group: 'frame', label: 'OpenFrame spare: hardware kit, 3"'},
  {sku: 'ACC-FRM-PAD', group: 'frame', label: 'OpenFrame spare: battery pad'},
  {sku: 'ACC-STRAP-20X220', group: 'strap', label: 'Battery strap, 20 x 220 mm'},
  {sku: 'ACC-STRAP-15X200', group: 'strap', label: 'Battery strap, 15 x 200 mm'},
];

const TRADE_SKU_SET = new Set(TRADE_SKUS.map((s) => s.sku));

export function isTradeSku(sku: string): boolean {
  return TRADE_SKU_SET.has(sku);
}

/** Countries a trade order ships to: the EU and the United States.
 *  `vatPrefix` is the VIES prefix, which is EL for Greece. */
export type TradeCountry = {code: string; name: string; vatPrefix: string | null};

export const TRADE_COUNTRIES: readonly TradeCountry[] = [
  ['AT', 'Austria'], ['BE', 'Belgium'], ['BG', 'Bulgaria'], ['HR', 'Croatia'],
  ['CY', 'Cyprus'], ['CZ', 'Czechia'], ['DK', 'Denmark'], ['EE', 'Estonia'],
  ['FI', 'Finland'], ['FR', 'France'], ['DE', 'Germany'], ['GR', 'Greece'],
  ['HU', 'Hungary'], ['IE', 'Ireland'], ['IT', 'Italy'], ['LV', 'Latvia'],
  ['LT', 'Lithuania'], ['LU', 'Luxembourg'], ['MT', 'Malta'], ['NL', 'Netherlands'],
  ['PL', 'Poland'], ['PT', 'Portugal'], ['RO', 'Romania'], ['SK', 'Slovakia'],
  ['SI', 'Slovenia'], ['ES', 'Spain'], ['SE', 'Sweden'], ['US', 'United States'],
].map(([code, name]) => ({code, name, vatPrefix: code === 'US' ? null : code === 'GR' ? 'EL' : code}));

export function tradeCountry(code: string): TradeCountry | undefined {
  return TRADE_COUNTRIES.find((c) => c.code === code);
}

/** VAT number formats by VIES prefix, the part after the prefix. A format
 *  check only: VIES says whether the number is live, and the proforma is
 *  checked against it before it goes out. */
const VAT_FORMATS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^[1-9]\d{1,9}$/,
  SE: /^\d{10}01$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

/** A VAT number in VIES form (`DE123456789`), or null when it does not fit
 *  the country's format. Spaces, dots and dashes are dropped; the prefix may
 *  be left out. */
export function normalizeVat(countryCode: string, raw: string): string | null {
  const prefix = tradeCountry(countryCode)?.vatPrefix;
  if (!prefix) return null;
  let v = raw.toUpperCase().replace(/[\s.\-]/g, '');
  if (v.startsWith(prefix)) v = v.slice(prefix.length);
  const format = VAT_FORMATS[prefix];
  return format?.test(v) ? `${prefix}${v}` : null;
}

/** A US EIN as `12-3456789`, or null. Nine digits; 00 is never a valid
 *  campus prefix. */
export function normalizeEin(raw: string): string | null {
  const digits = raw.replace(/[\s\-]/g, '');
  if (!/^\d{9}$/.test(digits) || digits.startsWith('00')) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

export const MAX_LINES = 30;
export const MAX_QTY = 10000;

export type TradeLine = {sku: string; label: string; qty: number};

export type TradeRequest = {
  shop: string;
  website: string;
  country: TradeCountry;
  /** VIES-form VAT number for an EU shop, EIN for a US shop. */
  taxId: string;
  contactName: string;
  email: string;
  lines: TradeLine[];
  shipTo: string;
  note: string;
  submittedAt: string;
};

export type TradeField =
  | 'shop'
  | 'website'
  | 'country'
  | 'taxId'
  | 'contactName'
  | 'email'
  | 'lines'
  | 'shipTo'
  | 'note';

export type TradeValidation =
  | {ok: true; request: TradeRequest}
  | {ok: false; errors: Partial<Record<TradeField, string>>};

/** The submitted values, as a form or the test's object. */
export type TradeInput = {
  get(name: string): unknown;
  getAll(name: string): unknown[];
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Label for a SKU: the catalog's when given, else the built-in one. */
export function tradeLabel(sku: string, labels?: Record<string, string>): string {
  return labels?.[sku] ?? TRADE_SKUS.find((s) => s.sku === sku)?.label ?? sku;
}

export function validateTradeRequest(
  form: TradeInput,
  now: Date = new Date(),
): TradeValidation {
  const errors: Partial<Record<TradeField, string>> = {};

  const shop = str(form.get('shop'), 200);
  if (!shop) errors.shop = 'Enter the shop name.';

  let website = str(form.get('site'), 300);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  let siteOk = false;
  try {
    const u = new URL(website);
    siteOk = /^https?:$/.test(u.protocol) && u.hostname.includes('.');
  } catch {
    siteOk = false;
  }
  if (!siteOk) errors.website = 'Enter the shop website.';

  const country = tradeCountry(str(form.get('country'), 2).toUpperCase());
  if (!country) errors.country = 'Choose an EU country or the United States.';

  const rawTax = str(form.get('taxId'), 40);
  let taxId = '';
  if (country) {
    if (country.code === 'US') {
      taxId = normalizeEin(rawTax) ?? '';
      if (!taxId) errors.taxId = 'Enter the EIN as 12-3456789.';
    } else {
      taxId = normalizeVat(country.code, rawTax) ?? '';
      if (!taxId) errors.taxId = `Enter a ${country.vatPrefix} VAT number for ${country.name}.`;
    }
  }

  const contactName = str(form.get('contactName'), 200);
  if (!contactName) errors.contactName = 'Enter a contact name.';

  const email = str(form.get('email'), 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter an email address.';

  const skus = form.getAll('sku');
  const qtys = form.getAll('qty');
  const lines: TradeLine[] = [];
  let lineError = '';
  if (skus.length > MAX_LINES) lineError = `At most ${MAX_LINES} lines.`;
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(skus.length, MAX_LINES) && !lineError; i++) {
    const sku = str(skus[i], 40);
    const qtyText = str(qtys[i], 10);
    if (!sku && !qtyText) continue;
    if (!isTradeSku(sku)) {
      lineError = 'Choose a product from the list.';
    } else if (!/^\d+$/.test(qtyText) || Number(qtyText) < 1 || Number(qtyText) > MAX_QTY) {
      lineError = `Quantity is a whole number from 1 to ${MAX_QTY}.`;
    } else if (seen.has(sku)) {
      lineError = 'Each product once; put the total on one line.';
    } else {
      seen.add(sku);
      lines.push({sku, label: tradeLabel(sku), qty: Number(qtyText)});
    }
  }
  if (!lineError && !lines.length) lineError = 'Add at least one product and quantity.';
  if (lineError) errors.lines = lineError;

  const shipTo = str(form.get('shipTo'), 1000);
  if (shipTo.length < 10) errors.shipTo = 'Enter the full ship-to address.';

  const note = str(form.get('note'), 2000);

  if (Object.keys(errors).length || !country) return {ok: false, errors};
  return {
    ok: true,
    request: {
      shop,
      website,
      country,
      taxId,
      contactName,
      email,
      lines,
      shipTo,
      note,
      submittedAt: now.toISOString(),
    },
  };
}

/** VAT treatment the proforma starts from, by destination. */
export function vatTreatment(country: TradeCountry): string {
  if (country.code === 'US') return 'Export outside the EU: no Belgian VAT (art. 39 WBTW). Shop is the importer.';
  if (country.code === 'BE') return 'Domestic sale: Belgian VAT 21%.';
  return 'Intra-Community supply: exempt (art. 39bis WBTW), check the VAT number in VIES first.';
}

export function buildTradeEmail(req: TradeRequest): {subject: string; text: string} {
  const pad = (label: string) => `${label}:`.padEnd(14, ' ');
  const lines = [
    'Trade request from opendrone.be/wholesale',
    '',
    `${pad('Shop')}${req.shop}`,
    `${pad('Website')}${req.website}`,
    `${pad('Country')}${req.country.name} (${req.country.code})`,
    `${pad(req.country.code === 'US' ? 'EIN' : 'VAT')}${req.taxId}`,
    `${pad('Contact')}${req.contactName}`,
    `${pad('Email')}${req.email}`,
    '',
    'Wanted:',
    ...req.lines.map((l) => `  ${String(l.qty).padStart(5, ' ')} x ${l.sku}  ${l.label}`),
    '',
    'Ship to:',
    ...req.shipTo.split(/\r?\n/).map((l) => `  ${l}`),
    '',
    `${pad('Note')}${req.note || '(none)'}`,
    '',
    `${pad('VAT')}${vatTreatment(req.country)}`,
    `${pad('Submitted')}${req.submittedAt}`,
    '',
    'Reply to this email with a proforma invoice. Business terms: Article 16 of the terms.',
  ];
  return {
    subject: `Trade request: ${req.shop} (${req.country.code})`,
    text: lines.join('\n'),
  };
}

const RESEND_API = 'https://api.resend.com/emails';

type MailEnv = {
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_NAME?: string;
  PUBLIC_COMPANY_EMAIL?: string;
};

export type TradeSendResult = {
  /** A mail key is set. False: nothing was attempted. */
  configured: boolean;
  /** The provider accepted the mail to the shop inbox. */
  sent: boolean;
};

/** Email the request to the company inbox, reply-to the shop. */
export async function sendTradeRequest(
  env: MailEnv,
  req: TradeRequest,
  fetcher: typeof fetch = fetch,
): Promise<TradeSendResult> {
  if (!env.RESEND_API_KEY) {
    console.warn('[trade/email] RESEND_API_KEY not set - request not sent', {shop: req.shop});
    return {configured: false, sent: false};
  }
  const from = env.SUPPORT_FROM_EMAIL || 'support@opendrone.be';
  const {subject, text} = buildTradeEmail(req);
  try {
    const res = await fetcher(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.PUBLIC_COMPANY_NAME ? `${env.PUBLIC_COMPANY_NAME} <${from}>` : from,
        to: [env.PUBLIC_COMPANY_EMAIL || 'contact@opendrone.be'],
        subject,
        text,
        reply_to: req.email,
      }),
    });
    if (!res.ok) console.error('[trade/email] send failed', res.status);
    return {configured: true, sent: res.ok};
  } catch (error) {
    console.error('[trade/email] send failed', error instanceof Error ? error.message : error);
    return {configured: true, sent: false};
  }
}

/**
 * When each trade group ships, from the preorder campaign: the first batch
 * of the group's lead SKU. A batch with a ship date gives that date; a
 * funding target gives the latest planned date and its deadline, as terms
 * 7bis.2 do. Trade goods ship with that batch because they go through
 * Leuven for QC and packing like every other unit.
 */
export type TradeLeadTime = {
  /** "late October 2026", or the latest planned date of a funding target. */
  date: string;
  /** The funding-target deadline the date depends on; null for a batch
   *  with its own ship date. */
  targetBy: string | null;
};

export function tradeLeadTimes(config: CampaignConfig): Record<TradeGroup, TradeLeadTime> {
  const leadOf: Record<TradeGroup, string> = {frame: 'OPENFRAME-5', strap: 'ACC-STRAP-20X220'};
  const out = {} as Record<TradeGroup, TradeLeadTime>;
  for (const group of Object.keys(leadOf) as TradeGroup[]) {
    const sku = leadOf[group];
    const rule = config.shipsWith?.[sku];
    const campaignSku = rule ? rule.sku : sku;
    const batches = config.skus[campaignSku]?.batches ?? [];
    const batch = rule?.batch ? batches[rule.batch - 1] : batches[0];
    const ships = batch?.ships?.replace(/^ships\s+/i, '').trim();
    out[group] = ships
      ? {date: ships, targetBy: null}
      : {date: latestShipDate(config), targetBy: campaignDate(config.endsOn)};
  }
  return out;
}
