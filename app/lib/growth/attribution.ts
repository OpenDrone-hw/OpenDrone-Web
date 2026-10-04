/**
 * First-touch channel attribution - session-scoped BY DESIGN.
 *
 * ePrivacy stance: no cookies, no localStorage - a `sessionStorage`
 * record only, so the data dies with the tab session. The cookie policy
 * names both keys (`od-attribution`, `od-attribution-sent`). The record
 * goes to the server only with the session's first add to cart
 * (`attributionFields`, sent by `postCart` in app/lib/cart-client.ts);
 * the cart action writes it as cart attributes, which Shopify copies onto
 * the order (`cartAttributesFromForm`, `ORDER_ATTRIBUTE`). Do NOT
 * "upgrade" this to persistent storage: the cookie policy says session.
 *
 * First touch wins: once a record exists for the session, later UTM hits
 * don't overwrite it. Values are trimmed, lowercased and capped at 64
 * chars to stay low-cardinality (canonical values in the README,
 * "Analytics and attribution").
 *
 * Creator links are `https://opendrone.be/?ref=<slug>`: `ref` is kept on
 * its own (`ref`) as well as being the `source` fallback, so a creator's
 * orders and events group by slug.
 */

export type Attribution = {
  /** utm_source, or `ref` fallback - e.g. 'youtube', 'discord'. */
  source: string;
  medium?: string;
  campaign?: string;
  /** utm_source exactly as given, when the link had one. */
  utmSource?: string;
  /** The `ref` slug (creator links), when the link had a valid one. */
  ref?: string;
  /** Landing pathname of the first touch. */
  landing: string;
  /** Capture time, ms epoch. */
  ts: number;
};

const STORAGE_KEY = 'od-attribution';
const SENT_KEY = 'od-attribution-sent';
const MAX_LEN = 64;

function clean(value: string | null | undefined): string | undefined {
  const v = value?.trim().toLowerCase().slice(0, MAX_LEN);
  return v || undefined;
}

/** A creator slug: lowercase letters, digits, `-` and `_`, 1 to 32
 *  characters, starting with a letter or digit. */
const REF_SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The `ref` value as a creator slug, or undefined when it is not one. */
export function refSlug(value: string | null | undefined): string | undefined {
  const v = clean(value);
  return v && REF_SLUG.test(v) ? v : undefined;
}

/**
 * Capture first-touch UTM/ref params from the current URL into
 * sessionStorage. Runs once per page load, on the landing URL: from
 * root.tsx on hydration, or earlier from `attributionProps`. Never
 * throws (sessionStorage can be unavailable in hardened privacy modes -
 * attribution is best-effort, the sale still works).
 */
let captured = false;

export function captureAttribution(): void {
  if (typeof window === 'undefined') return;
  // Only the landing URL counts: later client-side navigations reuse it.
  if (captured) return;
  captured = true;
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY)) return; // first touch wins
    const params = new URLSearchParams(window.location.search);
    const utmSource = clean(params.get('utm_source'));
    const ref = refSlug(params.get('ref'));
    const source = utmSource ?? ref;
    const medium = clean(params.get('utm_medium'));
    const campaign = clean(params.get('utm_campaign'));
    if (!source && !medium && !campaign) return;
    const record: Attribution = {
      source: source ?? 'unknown',
      medium,
      campaign,
      utmSource,
      ref,
      landing: window.location.pathname.slice(0, MAX_LEN),
      ts: Date.now(),
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage blocked - skip silently.
  }
}

/** The session's first-touch record, or null (direct visit / SSR / blocked). */
export function getAttribution(): Attribution | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Attribution;
    if (!parsed || typeof parsed.source !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Canonical utm_source values (docs/growth-architecture.md, "Canonical
 * UTM values", lowercase, exactly these). Everything else folds to
 * 'other' in event props, so a crafted `?utm_source=` link cannot spray
 * unbounded prop cardinality across the Plausible dashboard. The raw
 * (capped, lowercased) value still flows into cart attributes and the
 * order ledger, where full detail is wanted.
 */
export const CANONICAL_SOURCES: ReadonlySet<string> = new Set([
  'youtube',
  'discord',
  'reddit',
  'bardwell',
  'newsletter',
  'x',
]);

/** Fold a raw utm_source into the bounded event-prop vocabulary:
 *  canonical value, 'other' (non-canonical), or 'direct' (absent). */
export function foldSource(source: string | null | undefined): string {
  if (!source) return 'direct';
  return CANONICAL_SOURCES.has(source) ? source : 'other';
}


/** Low-cardinality event prop: first-touch utm_source folded to the
 *  canonical vocabulary, else 'direct'. */
export function attributionSource(): string {
  return foldSource(getAttribution()?.source);
}

/**
 * Bounded props for every Plausible event, pageviews included: the folded
 * `source`, plus the creator `ref` slug when the visit came from a
 * creator link. Captures first: a child route's effect (PDP View) runs
 * before root's capture effect on the landing page.
 */
export function attributionProps(): {source: string; ref?: string} {
  captureAttribution();
  const record = getAttribution();
  const source = foldSource(record?.source);
  return record?.ref ? {source, ref: record.ref} : {source};
}

/**
 * Form fields carrying the attribution record to the cart action, and
 * the cart attribute each becomes. Shopify copies cart attributes onto
 * the order as note attributes; the leading `_` keeps them out of the
 * buyer's view. `scripts/attribution-report.mjs` reads them back.
 */
export const ORDER_ATTRIBUTE = {
  ref: '_ref',
  utmSource: '_utm_source',
  medium: '_utm_medium',
  campaign: '_utm_campaign',
  landing: '_landing',
} as const;

type AttributionKey = keyof typeof ORDER_ATTRIBUTE;

const FIELD_PREFIX = 'attr_';

/** The session's attribution as cart form fields, empty when there is none. */
export function attributionFields(record: Attribution | null = getAttribution()): Array<[string, string]> {
  if (!record) return [];
  // A record from before `utmSource` existed: its source was utm_source.
  const utmSource = record.utmSource ?? (record.ref || record.source === 'unknown' ? undefined : record.source);
  const values: Partial<Record<AttributionKey, string | undefined>> = {
    ref: record.ref,
    utmSource,
    medium: record.medium,
    campaign: record.campaign,
    landing: record.landing,
  };
  return Object.entries(values)
    .filter((entry): entry is [AttributionKey, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .map(([key, value]) => [`${FIELD_PREFIX}${key}`, value]);
}

/** A campaign value: what `clean` keeps, minus anything but URL-safe text. */
const VALUE = /^[a-z0-9._~%+-]{1,64}$/;
/** A landing path: a pathname of at most 64 characters. */
const LANDING = /^\/[A-Za-z0-9._~%/-]{0,63}$/;

/**
 * Server side: the cart attributes a cart form carries, validated. A
 * field that does not pass is dropped, never stored. Empty when the form
 * carries no attribution.
 */
export function cartAttributesFromForm(form: FormData): Array<{key: string; value: string}> {
  const attributes: Array<{key: string; value: string}> = [];
  for (const key of Object.keys(ORDER_ATTRIBUTE) as AttributionKey[]) {
    const raw = form.get(`${FIELD_PREFIX}${key}`);
    if (typeof raw !== 'string') continue;
    const value = key === 'landing' ? raw.trim() : key === 'ref' ? refSlug(raw) : clean(raw);
    if (!value) continue;
    if (key === 'landing' ? !LANDING.test(value) : !VALUE.test(value)) continue;
    attributes.push({key: ORDER_ATTRIBUTE[key], value});
  }
  return attributes;
}

/**
 * Once-per-session latch for the cart-attributes promotion, so repeated
 * adds don't re-submit the same AttributesUpdate. Check `wasAttributionSent`
 * before submitting, `markAttributionSent` immediately when submitting.
 */
export function wasAttributionSent(): boolean {
  if (typeof window === 'undefined') return true; // never submit during SSR
  try {
    return window.sessionStorage.getItem(SENT_KEY) === '1';
  } catch {
    return true; // storage blocked → no attribution captured either
  }
}

export function markAttributionSent(): void {
  try {
    window.sessionStorage.setItem(SENT_KEY, '1');
  } catch {
    // ignore
  }
}
