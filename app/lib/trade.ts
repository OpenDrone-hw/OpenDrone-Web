/** Wholesale applications live in Shopify Companies. No ordering access is
 * granted by this module. Buyer contacts, quotes and approval stay in admin. */
import {adminEndpoint, adminGraphql, type AdminEnv} from './preorder-fulfilment.ts';
import {sha256Hex} from './accounts/crypto.ts';

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

export type TradeEnv = AdminEnv & {SHOPIFY_TRADE_WRITE_ENABLED?: string};
export function tradeConfigured(env: TradeEnv): boolean {
  if (env.SHOPIFY_TRADE_WRITE_ENABLED !== '1') return false;
  try { adminEndpoint(env); return true; } catch { return false; }
}

export const FIND_APPLICATION = `#graphql
  query WholesaleApplication($query: String!) {
    companies(first: 2, query: $query) {
      nodes { id externalId }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
export const CREATE_APPLICATION = `#graphql
  mutation WholesaleApply($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company { id externalId }
      userErrors { field code message }
    }
  }
`;

type CompanyRef = {id: string; externalId: string | null};
export type ApplicationResult = {ok: true} | {ok: false; reason: 'not_configured' | 'unavailable'};

/** A retry checks Shopify first. The application key is not a buyer identity.
 * No contact or role is created from an unverified public email address. */
export async function submitTradeApplication(
  env: TradeEnv,
  application: TradeApplication,
  fetcher: typeof fetch = fetch,
): Promise<ApplicationResult> {
  if (!tradeConfigured(env)) return {ok: false, reason: 'not_configured'};
  const externalId = `wholesale-${await sha256Hex(JSON.stringify([
    application.email, application.company.toLowerCase().replace(/\s+/g, ' '), application.country.code,
  ]))}`;
  const find = async () => {
    const data = await adminGraphql<{companies: {nodes: CompanyRef[]; pageInfo: {hasNextPage: boolean}}}>(
      env, FIND_APPLICATION, {query: `external_id:"${externalId}"`}, fetcher,
    );
    // Search can be broader than requested; match the identity ourselves.
    return data.companies.nodes.find((company) => company.externalId === externalId);
  };
  try {
    if (await find()) return {ok: true};
    const note = [
      'Wholesale application from https://opendrone.be/wholesale',
      'Pending review. Contact details are applicant-supplied and unverified.',
      `Contact: ${application.contactName}`,
      `Email: ${application.email}`,
      `Country: ${application.country.name} (${application.country.code})`,
      application.website ? `Shop website: ${application.website}` : '',
      application.note ? `Message:\n${application.note}` : '',
    ].filter(Boolean).join('\n');
    const result = await adminGraphql<{companyCreate: {
      company: CompanyRef | null;
      userErrors: Array<{code: string; message: string}>;
    }}>(env, CREATE_APPLICATION, {input: {
      company: {name: application.company, externalId, note},
      companyLocation: {name: application.country.name},
    }}, fetcher);
    if (result.companyCreate.userErrors.length || !result.companyCreate.company) {
      // A simultaneous request may already have created this identity.
      if (await find()) return {ok: true};
      return {ok: false, reason: 'unavailable'};
    }
    if (result.companyCreate.company.externalId !== externalId) return {ok: false, reason: 'unavailable'};
    return {ok: true};
  } catch {
    // A timeout can happen after a successful mutation. Only confirm a saved
    // company; never repeat a mutation with an unknown result.
    try { if (await find()) return {ok: true}; } catch { /* no confirmed record */ }
    return {ok: false, reason: 'unavailable'};
  }
}
