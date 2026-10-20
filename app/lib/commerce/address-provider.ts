/**
 * Address suggestions behind one interface. The browser asks our own Worker (/shop/address), the Worker asks the
 * provider, so a visitor's IP address and cookies never reach it; only the typed text and the country do.
 *
 *   photon   photon.komoot.io, OpenStreetMap data (ODbL), no key, run in Germany by komoot. Fair use, no SLA.
 *   geoapify api.geoapify.com, an EU company (Germany), OSM based, key needed, free to 3000 requests a day.
 *   none     no suggestions (the default): the form still works, with postcode to city fill.
 *
 * ADDRESS_PROVIDER picks one; a provider that fails or times out answers with no suggestions, never an error.
 */
import {formatLine1} from './address-fields.ts';

export type Suggestion = {label: string; line1: string; postal_code: string; city: string};

export type AddressProvider = {
  id: 'photon' | 'geoapify' | 'none';
  suggest(query: string, country: string, fetcher?: typeof fetch): Promise<Suggestion[]>;
};

export type AddressEnv = {ADDRESS_PROVIDER?: string; GEOAPIFY_API_KEY?: string};

export const MIN_CHARS = 3;
export const MAX_SUGGESTIONS = 5;
const TIMEOUT_MS = 3000;
const UA = 'OpenDrone-Web checkout address suggestions (opendrone.be)';

const CENTRE: Record<string, [number, number]> = {BE: [50.5, 4.5], NL: [52.2, 5.3], DE: [51.1, 10.4], FR: [46.6, 2.5], LU: [49.8, 6.1]};

type PhotonFeature = {properties: {street?: string; name?: string; housenumber?: string; postcode?: string; city?: string; town?: string; village?: string; countrycode?: string; type?: string}};
type GeoapifyResult = {street?: string; housenumber?: string; postcode?: string; city?: string; town?: string; village?: string; municipality?: string; suburb?: string; county?: string; country_code?: string};

function build(country: string, street?: string, housenumber?: string, postcode?: string, city?: string): Suggestion | null {
  if (!street || !city) return null;
  const line1 = formatLine1(street, housenumber ?? '', country);
  const code = postcode ?? '';
  return {label: [line1, [code, city].filter(Boolean).join(' ')].join(', '), line1, postal_code: code, city};
}

function unique(list: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true))).slice(0, MAX_SUGGESTIONS);
}

/** How the provider answered the last lookup of this isolate: an HTTP status, `timeout` or `error`. Diagnostics only (the
 *  route sends it as a header so a silent empty list can be told apart from a refused one); never the query. */
let lastStatus = '';
export function lastProviderStatus(): string {
  return lastStatus;
}

async function getJson(url: string, fetcher: typeof fetch, headers: Record<string, string> = {}): Promise<unknown> {
  try {
    const res = await fetcher(url, {headers: {accept: 'application/json', 'user-agent': UA, ...headers}, signal: AbortSignal.timeout(TIMEOUT_MS)});
    lastStatus = String(res.status);
    if (!res.ok) console.warn(`[address] provider answered HTTP ${res.status}`);
    return res.ok ? await res.json() : null;
  } catch (err) {
    lastStatus = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'error';
    console.warn(`[address] provider unreachable: ${lastStatus}`);
    return null;
  }
}

export const photon: AddressProvider = {
  id: 'photon',
  async suggest(query, country, fetcher = fetch) {
    const cc = country.toUpperCase();
    const bias = CENTRE[cc];
    const params = new URLSearchParams({q: query, limit: '20', lang: 'en'});
    params.append('layer', 'house');
    params.append('layer', 'street');
    if (bias) {
      params.set('lat', String(bias[0]));
      params.set('lon', String(bias[1]));
    }
    const body = (await getJson(`https://photon.komoot.io/api/?${params}`, fetcher)) as {features?: PhotonFeature[]} | null;
    const out: Suggestion[] = [];
    for (const f of body?.features ?? []) {
      const p = f.properties;
      if ((p.countrycode ?? '').toUpperCase() !== cc) continue;
      const s = build(cc, p.street ?? p.name, p.housenumber, p.postcode, p.city ?? p.town ?? p.village);
      if (s) out.push(s);
    }
    return unique(out);
  },
};

export function geoapify(key: string): AddressProvider {
  return {
    id: 'geoapify',
    async suggest(query, country, fetcher = fetch) {
      const cc = country.toUpperCase();
      // No `type`: type=street matches bare streets only, so a typed house number ("Bondgenotenlaan 9") found nothing on the
      // hosted shop; buildings (with a house number) and streets both come back, and build() keeps those with street and city.
      const params = new URLSearchParams({text: query, format: 'json', limit: '10', lang: 'en', filter: `countrycode:${cc.toLowerCase()}`, apiKey: key});
      const body = (await getJson(`https://api.geoapify.com/v1/geocode/autocomplete?${params}`, fetcher)) as {results?: GeoapifyResult[]} | null;
      const out: Suggestion[] = [];
      for (const r of body?.results ?? []) {
        const s = build(cc, r.street, r.housenumber, r.postcode, r.city ?? r.town ?? r.village ?? r.municipality ?? r.suburb ?? r.county);
        if (s) out.push(s);
      }
      return unique(out);
    },
  };
}

export const none: AddressProvider = {id: 'none', suggest: async () => []};

export function addressProvider(env: AddressEnv): AddressProvider {
  const id = (env.ADDRESS_PROVIDER ?? '').toLowerCase();
  if (id === 'photon') return photon;
  if (id === 'geoapify' && env.GEOAPIFY_API_KEY) return geoapify(env.GEOAPIFY_API_KEY);
  return none;
}

/** The query as sent on: trimmed, capped, with control characters dropped; null when too short to be worth a call. */
export function cleanQuery(raw: string | null): string | null {
  const q = (raw ?? '').replace(/\s/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return q.length >= MIN_CHARS ? q : null;
}

/** The answer of GET /shop/address?q=&country=: the suggestions and the headers, with the provider and how it answered in
 *  X-Address-Provider ("geoapify 200 5", "none 0"). Pure apart from the provider call, so the route has a test. */
export async function addressAnswer(env: AddressEnv, url: URL, fetcher: typeof fetch = fetch): Promise<{suggestions: Suggestion[]; headers: Record<string, string>}> {
  const q = cleanQuery(url.searchParams.get('q'));
  const country = (url.searchParams.get('country') ?? '').toUpperCase();
  const provider = addressProvider(env);
  const suggestions = q && /^[A-Z]{2}$/.test(country) ? await provider.suggest(q, country, fetcher) : [];
  const status = provider.id === 'none' || !q ? '' : lastProviderStatus();
  const headers: Record<string, string> = {
    'Cache-Control': suggestions.length ? 'private, max-age=300' : 'no-store',
    'X-Robots-Tag': 'noindex',
    'X-Address-Provider': `${provider.id}${status ? ` ${status}` : ''} ${suggestions.length}`,
  };
  return {suggestions, headers};
}
