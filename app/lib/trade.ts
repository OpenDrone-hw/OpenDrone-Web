/**
 * Trade orders: a shop asks for a quote through /wholesale instead of using
 * the consumer checkout. A request is not an accepted order. This
 * module holds what the page quotes, the request validation, the email to
 * the shop inbox and the lead times read from `content/preorders.json`.
 *
 * Mail goes through Resend with the same variables as the withdrawal form
 * (`RESEND_API_KEY`, `SUPPORT_FROM_EMAIL`, `PUBLIC_COMPANY_EMAIL`). Without a
 * key nothing is sent and the result says so, so the page never tells a shop
 * its request arrived when it did not. An EU VAT number is also looked up
 * in VIES; the answer goes in the email and never blocks a request.
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it.
 */

import {campaignDate, latestShipDate, type CampaignConfig} from './preorder-campaign.ts';

/** What a shop can ask a quote for: the whole range, by product group. */
export type TradeGroup = 'fc' | 'esc' | 'rx' | 'motor' | 'frame' | 'strap' | 'prop';

/** The order the groups are listed in. */
export const TRADE_GROUPS: readonly TradeGroup[] = ['fc', 'esc', 'rx', 'motor', 'frame', 'strap', 'prop'];

export type TradeSku = {sku: string; group: TradeGroup; label: string};

export const TRADE_SKUS: readonly TradeSku[] = [
  {sku: 'OPENFC-LITE-2020', group: 'fc', label: 'OpenFC Lite Mini, 20x20'},
  {sku: 'OPENFC-LITE-3030', group: 'fc', label: 'OpenFC Lite, 30x30'},
  {sku: 'OPENESC-2020', group: 'esc', label: 'OpenESC 20x20'},
  {sku: 'OPENESC-3030', group: 'esc', label: 'OpenESC 30x30'},
  {sku: 'ACC-CAP-470UF-35V', group: 'esc', label: 'Capacitor, 470 µF 35 V low-ESR'},
  {sku: 'ACC-CAP-470UF-50V', group: 'esc', label: 'Capacitor, 470 µF 50 V low-ESR'},
  {sku: 'OPENRX-LITE', group: 'rx', label: 'OpenRX Lite'},
  {sku: 'OPENRX-LITE-UFL', group: 'rx', label: 'OpenRX Lite U.FL'},
  {sku: 'OPENRX-MONO', group: 'rx', label: 'OpenRX Mono'},
  {sku: 'OPENRX-GEMINI', group: 'rx', label: 'OpenRX Gemini'},
  {sku: 'ACC-ANT-T', group: 'rx', label: 'ELRS 2.4 GHz U.FL T antenna'},
  {sku: 'ACC-ANT-DUAL-T', group: 'rx', label: 'ELRS 868/915 MHz + 2.4 GHz U.FL T antenna'},
  {sku: 'OPENMOTOR-1604', group: 'motor', label: 'OpenMotor 1604, 3" class'},
  {sku: 'OPENMOTOR-2207', group: 'motor', label: 'OpenMotor 2207, 5" class'},
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
  {sku: 'ACC-FRM-HW-5', group: 'frame', label: 'OpenFrame spare: hardware kit, 5"'},
  {sku: 'ACC-FRM-HW-3', group: 'frame', label: 'OpenFrame spare: hardware kit, 3"'},
  {sku: 'ACC-FRM-PAD', group: 'frame', label: 'OpenFrame spare: battery pad'},
  {sku: 'ACC-STRAP-20X220', group: 'strap', label: 'Battery strap, 20 x 220 mm'},
  {sku: 'ACC-STRAP-15X200', group: 'strap', label: 'Battery strap, 15 x 200 mm'},
  {sku: 'ACC-PROP-3-HQ-T3X3X3', group: 'prop', label: 'HQProp T3x3x3, 3" T-mount'},
  {sku: 'ACC-PROP-3-HQ-T3X2X3-DUR', group: 'prop', label: 'HQProp Durable T3x2x3, 3" T-mount'},
  {sku: 'ACC-PROP-3-GF-3020', group: 'prop', label: 'Gemfan 3020-3, 3" T-mount'},
  {sku: 'ACC-PROP-5-HQ-5X43X3-V2S', group: 'prop', label: 'HQProp 5x4.3x3 V2S, 5"'},
  {sku: 'ACC-PROP-5-HQ-J37', group: 'prop', label: 'HQProp Juicy J37, 5"'},
  {sku: 'ACC-PROP-5-GF-51466', group: 'prop', label: 'Gemfan Hurricane 51466 V2, 5"'},
];

const TRADE_SKU_MAP = new Map(TRADE_SKUS.map((s) => [s.sku, s]));

export function isTradeSku(sku: string): boolean {
  return TRADE_SKU_MAP.has(sku);
}

/** True when the SKU and country accept enquiries, not import approval. */
export function tradeSkuAvailable(sku: string, countryCode: string): boolean {
  return Boolean(tradeCountry(countryCode) && isTradeSku(sku));
}

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

/** Which tax id a shop gives: an EU VAT number, a US EIN, or elsewhere its
 *  VAT or tax number as written. */
export function taxIdKind(country: TradeCountry): 'vat' | 'ein' | 'other' {
  return country.vatPrefix ? 'vat' : country.code === 'US' ? 'ein' : 'other';
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

/** How the shop sells. */
export type ShopType = 'online' | 'physical' | 'both';
export const SHOP_TYPES: readonly ShopType[] = ['online', 'physical', 'both'];

/** Expected reorders per month, excluding VAT. Optional on the form. */
export const VOLUME_BANDS = ['unsure', 'lt1k', '1k-5k', '5k-20k', 'gt20k'] as const;
export type VolumeBand = (typeof VOLUME_BANDS)[number];

/** Where the shop heard of OpenDrone. Optional on the form. */
export const LEAD_SOURCES = ['search', 'social', 'video', 'community', 'event', 'referral', 'other'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

/** The words the email uses. The page reads its own labels from
 *  `content/copy/wholesale.json`. */
const SHOP_TYPE_TEXT: Record<ShopType, string> = {
  online: 'Online shop',
  physical: 'Physical shop',
  both: 'Online and physical shop',
};
const VOLUME_TEXT: Record<VolumeBand, string> = {
  unsure: 'Not sure yet',
  lt1k: 'Under EUR 1,000 per month',
  '1k-5k': 'EUR 1,000 to 5,000 per month',
  '5k-20k': 'EUR 5,000 to 20,000 per month',
  gt20k: 'Over EUR 20,000 per month',
};
const SOURCE_TEXT: Record<LeadSource, string> = {
  search: 'Search engine',
  social: 'Social media',
  video: 'YouTube or a review',
  community: 'Discord or an FPV community',
  event: 'Trade show or event',
  referral: 'Recommendation',
  other: 'Other',
};

export type TradeLine = {sku: string; label: string; qty: number};

/** The live VIES answer for an EU VAT number. It never blocks a request:
 *  it tells the quote whether the number was live when the shop sent it. */
export type ViesResult = {
  status: 'valid' | 'invalid' | 'unavailable';
  name?: string;
  address?: string;
};

export type TradeRequest = {
  /** Company legal name, as it goes on the invoice. */
  company: string;
  contactName: string;
  email: string;
  phone: string;
  /** Website or shop URL; may be empty for a physical-only shop. */
  website: string;
  shopType: ShopType;
  country: TradeCountry;
  /** VIES-form VAT number for an EU shop, EIN for a US shop. */
  taxId: string;
  lines: TradeLine[];
  shipTo: string;
  /** Null when billing goes to the shipping address. */
  billTo: string | null;
  volume: VolumeBand | null;
  /** Wanted delivery date, YYYY-MM-DD, or null. */
  deliveryBy: string | null;
  source: LeadSource | null;
  note: string;
  submittedAt: string;
  /** Set by the action after validation, for an EU VAT number. */
  vies?: ViesResult | null;
};

export type TradeField =
  | 'company'
  | 'contactName'
  | 'email'
  | 'phone'
  | 'website'
  | 'shopType'
  | 'country'
  | 'taxId'
  | 'lines'
  | 'shipTo'
  | 'billTo'
  | 'volume'
  | 'deliveryBy'
  | 'source';

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

/** A phone number a carrier can use: 6 to 15 digits, an optional leading
 *  +, and spaces, dots, dashes, slashes or brackets between them. */
export function normalizePhone(raw: string): string | null {
  const v = raw.replace(/\s+/g, ' ').trim();
  if (!/^\+?[\d\s().\-/]+$/.test(v)) return null;
  const digits = v.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 15 ? v : null;
}

const oneOf = <T extends string>(list: readonly T[], v: string): T | null =>
  (list as readonly string[]).includes(v) ? (v as T) : null;

export function validateTradeRequest(
  form: TradeInput,
  now: Date = new Date(),
): TradeValidation {
  const errors: Partial<Record<TradeField, string>> = {};

  const company = str(form.get('company'), 200);
  if (!company) errors.company = 'Enter the company legal name.';

  const contactName = str(form.get('contactName'), 200);
  if (!contactName) errors.contactName = 'Enter a contact name.';

  const email = str(form.get('email'), 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter an email address.';

  const phone = normalizePhone(str(form.get('phone'), 40)) ?? '';
  if (!phone) errors.phone = 'Enter a phone number with country code.';

  const shopType = oneOf(SHOP_TYPES, str(form.get('shopType'), 10));
  if (!shopType) errors.shopType = 'Choose how you sell.';

  // A physical-only shop may have no website; everyone else needs one.
  let website = str(form.get('site'), 300);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  if (website) {
    let siteOk = false;
    try {
      const u = new URL(website);
      siteOk = /^https?:$/.test(u.protocol) && u.hostname.includes('.');
    } catch {
      siteOk = false;
    }
    if (!siteOk) errors.website = 'Enter a web address, for example shop.example.';
  } else if (shopType !== 'physical') {
    errors.website = 'Enter the shop website.';
  }

  const country = tradeCountry(str(form.get('country'), 2).toUpperCase());
  if (!country) errors.country = 'Choose a country from the list.';

  const rawTax = str(form.get('taxId'), 40);
  let taxId = '';
  if (country) {
    const kind = taxIdKind(country);
    if (kind === 'ein') {
      taxId = normalizeEin(rawTax) ?? '';
      if (!taxId) errors.taxId = 'Enter the EIN as 12-3456789.';
    } else if (kind === 'vat') {
      taxId = normalizeVat(country.code, rawTax) ?? '';
      if (!taxId) errors.taxId = `Enter a ${country.vatPrefix} VAT number for ${country.name}.`;
    } else {
      taxId = rawTax.replace(/\s+/g, ' ');
      if (taxId.length < 4) errors.taxId = `Enter the VAT or tax number for ${country.name}.`;
    }
  }

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
    } else if (country && !tradeSkuAvailable(sku, country.code)) {
      lineError = 'Not available for this country';
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
  if (shipTo.length < 10) errors.shipTo = 'Enter the full shipping address.';

  // The billing address is the shipping one unless the box is unticked.
  const billingSame = form.get('billingSame') === 'on';
  const billTo = billingSame ? null : str(form.get('billTo'), 1000);
  if (billTo !== null && billTo.length < 10) errors.billTo = 'Enter the full billing address.';

  const volumeText = str(form.get('volume'), 10);
  const volume = volumeText ? oneOf(VOLUME_BANDS, volumeText) : null;
  if (volumeText && !volume) errors.volume = 'Choose an option from the list.';

  const sourceText = str(form.get('source'), 12);
  const source = sourceText ? oneOf(LEAD_SOURCES, sourceText) : null;
  if (sourceText && !source) errors.source = 'Choose an option from the list.';

  // A wanted delivery date, from today up to two years ahead.
  const deliveryText = str(form.get('deliveryBy'), 10);
  let deliveryBy: string | null = null;
  if (deliveryText) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(deliveryText) ? Date.parse(`${deliveryText}T00:00:00Z`) : NaN;
    const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(day) || day < today || day > today + 731 * 86_400_000) {
      errors.deliveryBy = 'Choose a date from today up to two years ahead.';
    } else {
      deliveryBy = deliveryText;
    }
  }

  const note = str(form.get('note'), 2000);

  if (Object.keys(errors).length || !country || !shopType) return {ok: false, errors};
  return {
    ok: true,
    request: {
      company,
      contactName,
      email,
      phone,
      website,
      shopType,
      country,
      taxId,
      lines,
      shipTo,
      billTo,
      volume,
      deliveryBy,
      source,
      note,
      submittedAt: now.toISOString(),
    },
  };
}

const VIES_API = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';

/** Ask VIES whether a VIES-form VAT number (`DE123456789`) is live. Any
 *  failure or timeout is `unavailable`, never a rejection. */
export async function checkVies(
  vat: string,
  fetcher: typeof fetch = fetch,
): Promise<ViesResult> {
  const m = /^([A-Z]{2})([0-9A-Z+*]+)$/.exec(vat);
  if (!m) return {status: 'unavailable'};
  try {
    const res = await fetcher(`${VIES_API}/${m[1]}/vat/${m[2]}`, {
      headers: {Accept: 'application/json', 'User-Agent': 'opendrone.be trade form'},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn('[trade/vies] lookup failed', res.status);
      return {status: 'unavailable'};
    }
    const body = (await res.json()) as {isValid?: boolean; userError?: string; name?: string; address?: string};
    const known = (v?: string) => (v && v.trim() && v.trim() !== '---' ? v.trim() : undefined);
    if (body.isValid === true) {
      return {status: 'valid', name: known(body.name), address: known(body.address)};
    }
    return body.userError === 'INVALID' ? {status: 'invalid'} : {status: 'unavailable'};
  } catch (error) {
    console.warn('[trade/vies] lookup failed', error instanceof Error ? error.message : error);
    return {status: 'unavailable'};
  }
}

/** VAT treatment the quote starts from, by destination. */
export function vatTreatment(country: TradeCountry): string {
  if (!country.vatPrefix) return 'US export enquiry: verify export evidence and VAT treatment. Agree the importer, broker, product eligibility and duties before accepting an order.';
  if (country.code === 'BE') return 'Domestic sale: Belgian VAT 21%.';
  return 'Potential intra-Community exemption: verify VIES and qualifying transport evidence before quoting VAT treatment.';
}

function viesText(vies: ViesResult | null | undefined): string | null {
  if (!vies) return null;
  if (vies.status === 'valid') {
    const who = [vies.name, vies.address?.replace(/\s*\n\s*/g, ', ')].filter(Boolean).join(', ');
    return `valid when submitted${who ? `: ${who}` : ''}`;
  }
  if (vies.status === 'invalid') return 'NOT valid when submitted; check the number before quoting';
  return 'not reachable when submitted; check by hand';
}

/** List prices by SKU from the shop catalog: the consumer price a quote
 *  starts from (a campaign SKU's compare-at price, else its price). */
export type TradePrices = {
  currency: string;
  /** The catalog prices include Belgian VAT at 21%. */
  includesVat: boolean;
  bySku: Record<string, number>;
};

type PricedLine = TradeLine & {unit: number | null; total: number | null};

function pricedLines(req: TradeRequest, prices?: TradePrices | null): {lines: PricedLine[]; total: number | null} {
  const exVat = (n: number) => (prices?.includesVat ? n / 1.21 : n);
  let total: number | null = 0;
  const lines = req.lines.map((l) => {
    const list = prices?.bySku[l.sku];
    const unit = typeof list === 'number' && list > 0 ? Math.round(exVat(list) * 100) / 100 : null;
    const lineTotal = unit === null ? null : Math.round(unit * l.qty * 100) / 100;
    total = lineTotal === null || total === null ? null : total + lineTotal;
    return {...l, unit, total: lineTotal};
  });
  return {lines, total: total === null ? null : Math.round(total * 100) / 100};
}

const money = (n: number | null) =>
  n === null ? '-' : n.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);

/** The quote request as the company inbox reads it: the details as label
 *  and value, then the products with list prices, then the terms to check.
 *  Plain text and HTML carry the same content. */
export function buildTradeEmail(
  req: TradeRequest,
  prices?: TradePrices | null,
): {subject: string; text: string; html: string} {
  const units = req.lines.reduce((n, l) => n + l.qty, 0);
  const priced = pricedLines(req, prices);
  const currency = prices?.currency ?? 'EUR';
  const taxLabel = {vat: 'VAT number', ein: 'EIN', other: 'Tax number'}[taxIdKind(req.country)];
  const vies = viesText(req.vies);

  const details: Array<[string, string]> = [
    ['Company', req.company],
    ['Contact', req.contactName],
    ['Email', req.email],
    ['Phone', req.phone],
    ['Website', req.website || '(none, physical shop)'],
    ['Shop type', SHOP_TYPE_TEXT[req.shopType]],
    ['Country', `${req.country.name} (${req.country.code})`],
    [taxLabel, req.taxId],
    ...(vies ? ([['VIES', vies]] as Array<[string, string]>) : []),
    ['Ship to', req.shipTo],
    ['Bill to', req.billTo ?? 'Same as ship to'],
    ['Delivery by', req.deliveryBy ?? '(not given)'],
    ['Volume', req.volume ? VOLUME_TEXT[req.volume] : '(not given)'],
    ['Heard via', req.source ? SOURCE_TEXT[req.source] : '(not given)'],
    ['Note', req.note || '(none)'],
  ];
  const priceBasis = prices
    ? `List = the shop's consumer price per unit${prices.includesVat ? ', 21% Belgian VAT removed' : ''}, in ${currency}. Not a trade price.`
    : 'List prices unavailable: the catalog did not answer.';

  const pad = (label: string) => `${label}:`.padEnd(14, ' ');
  const indent = (value: string) => value.split(/\r?\n/).join(`\n${' '.repeat(14)}`);
  const text = [
    'Quote request from opendrone.be/wholesale',
    '',
    ...details.map(([k, v]) => `${pad(k)}${indent(v)}`),
    '',
    `Products (${units} units):`,
    `  ${'Qty'.padStart(5)}  ${'SKU'.padEnd(26)}${'List ex VAT'.padStart(12)}${'Line'.padStart(12)}  Product`,
    ...priced.lines.map(
      (l) =>
        `  ${String(l.qty).padStart(5)}  ${l.sku.padEnd(26)}${money(l.unit).padStart(12)}${money(l.total).padStart(12)}  ${l.label}`,
    ),
    `  ${''.padStart(5)}  ${'Total at list'.padEnd(26)}${''.padStart(12)}${money(priced.total).padStart(12)}`,
    `  ${priceBasis}`,
    '',
    `${pad('VAT')}${vatTreatment(req.country)}`,
    `${pad('Submitted')}${req.submittedAt}`,
    '',
    'Reply to this email with a quote. Business terms: Article 16 of the terms.',
  ].join('\n');

  const cell = 'padding:4px 8px;border-bottom:1px solid #ddd;vertical-align:top;';
  const num = `${cell}text-align:right;white-space:nowrap;`;
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;">',
    '<p style="margin:0 0 12px;">Quote request from opendrone.be/wholesale</p>',
    '<table style="border-collapse:collapse;margin-bottom:16px;">',
    ...details.map(
      ([k, v]) =>
        `<tr><th style="${cell}text-align:left;color:#555;font-weight:600;white-space:nowrap;">${escapeHtml(k)}</th><td style="${cell}white-space:pre-line;">${escapeHtml(v)}</td></tr>`,
    ),
    '</table>',
    `<p style="margin:0 0 6px;font-weight:600;">Products (${units} units)</p>`,
    '<table style="border-collapse:collapse;margin-bottom:6px;">',
    `<tr><th style="${num}">Qty</th><th style="${cell}text-align:left;">SKU</th><th style="${cell}text-align:left;">Product</th><th style="${num}">List ex VAT</th><th style="${num}">Line</th></tr>`,
    ...priced.lines.map(
      (l) =>
        `<tr><td style="${num}">${l.qty}</td><td style="${cell}font-family:monospace;">${escapeHtml(l.sku)}</td><td style="${cell}">${escapeHtml(l.label)}</td><td style="${num}">${money(l.unit)}</td><td style="${num}">${money(l.total)}</td></tr>`,
    ),
    `<tr><td style="${num}font-weight:600;">${units}</td><td style="${cell}" colspan="3">Total at list</td><td style="${num}font-weight:600;">${money(priced.total)}</td></tr>`,
    '</table>',
    `<p style="margin:0 0 16px;color:#555;font-size:12px;">${escapeHtml(priceBasis)}</p>`,
    `<p style="margin:0 0 4px;"><strong>VAT:</strong> ${escapeHtml(vatTreatment(req.country))}</p>`,
    `<p style="margin:0 0 12px;color:#555;">Submitted ${escapeHtml(req.submittedAt)}</p>`,
    '<p style="margin:0;">Reply to this email with a quote. Business terms: Article 16 of the terms.</p>',
    '</div>',
  ].join('\n');

  return {
    subject: `Quote request: ${req.company} (${req.country.code}), ${units} units`,
    text,
    html,
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

/** Email the request to the company inbox, reply-to the shop. Nothing goes
 *  to the shop: the page shows it what it sent. */
export async function sendTradeRequest(
  env: MailEnv,
  req: TradeRequest,
  fetcher: typeof fetch = fetch,
  prices?: TradePrices | null,
): Promise<TradeSendResult> {
  if (!env.RESEND_API_KEY) {
    console.warn('[trade/email] RESEND_API_KEY not set - request not sent', {company: req.company});
    return {configured: false, sent: false};
  }
  const from = env.SUPPORT_FROM_EMAIL || 'support@opendrone.be';
  const {subject, text, html} = buildTradeEmail(req, prices);
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
        html,
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
 * of the group's lead SKU (for an accessory, the batch it ships with). A batch with a ship date gives that date; a
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
  const leadOf: Record<TradeGroup, string> = {
    fc: 'OPENFC-LITE-2020',
    esc: 'OPENESC-2020',
    rx: 'OPENRX-LITE',
    motor: 'OPENMOTOR-2207',
    frame: 'OPENFRAME-5',
    strap: 'ACC-STRAP-20X220',
    prop: 'ACC-PROP-5-HQ-J37',
  };
  const out = {} as Record<TradeGroup, TradeLeadTime>;
  for (const group of TRADE_GROUPS) {
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
