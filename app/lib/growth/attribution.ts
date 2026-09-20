/**
 * First-touch channel attribution - session-scoped BY DESIGN.
 *
 * ePrivacy stance (growth-infra brief, pending legal review 18-jul): no
 * cookies, no localStorage - a `sessionStorage` record only, so the data
 * dies with the tab session. It is promoted server-side into cart
 * attributes (→ Shopify order custom attributes) only when the visitor
 * acts (add-to-cart), via the allowlisted AttributesUpdate case in
 * app/routes/cart.tsx. Do NOT "upgrade" this to persistent storage
 * without the legal verdict.
 *
 * First touch wins: once a record exists for the session, later UTM hits
 * don't overwrite it. Values are trimmed, lowercased and capped at 64
 * chars to stay low-cardinality (canonical values in
 * drafts/utm-conventions.md).
 */

export type Attribution = {
  /** utm_source, or `ref` fallback - e.g. 'youtube', 'discord'. */
  source: string;
  medium?: string;
  campaign?: string;
  /** Landing pathname of the first touch. */
  landing: string;
  /** Capture time, ms epoch. */
  ts: number;
};

const STORAGE_KEY = 'od-attribution';
const SENT_KEY = 'od-attribution-sent';
const MAX_LEN = 64;

function clean(value: string | null): string | undefined {
  const v = value?.trim().toLowerCase().slice(0, MAX_LEN);
  return v || undefined;
}

/**
 * Capture first-touch UTM/ref params from the current URL into
 * sessionStorage. Call once on hydration (root.tsx). Idempotent; never
 * throws (sessionStorage can be unavailable in hardened privacy modes -
 * attribution is best-effort, the sale still works).
 */
export function captureAttribution(): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY)) return; // first touch wins
    const params = new URLSearchParams(window.location.search);
    const source = clean(params.get('utm_source')) ?? clean(params.get('ref'));
    const medium = clean(params.get('utm_medium'));
    const campaign = clean(params.get('utm_campaign'));
    if (!source && !medium && !campaign) return;
    const record: Attribution = {
      source: source ?? 'unknown',
      medium,
      campaign,
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
