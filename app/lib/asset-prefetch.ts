/**
 * Tiny client-side asset prefetch + cache, shared by the board-art and
 * schematic viewers. It lets a variant/tier toggle swap between already-warmed
 * assets with no network round-trip and no blank frame: siblings are fetched
 * in the background while the current asset is on screen, then a toggle is a
 * synchronous cache hit.
 *
 * Every cache is module-level, so it persists across component remounts and is
 * shared between all viewer instances on the page.
 */

const textCache = new Map<string, string>();
const textInflight = new Map<string, Promise<string>>();

/** Fetch text (e.g. a layered board SVG) once; repeat calls resolve from cache. */
export function fetchTextCached(url: string): Promise<string> {
  const hit = textCache.get(url);
  if (hit != null) return Promise.resolve(hit);
  let inflight = textInflight.get(url);
  if (!inflight) {
    inflight = fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((text) => {
        textCache.set(url, text);
        textInflight.delete(url);
        return text;
      })
      .catch((err) => {
        textInflight.delete(url);
        throw err;
      });
    textInflight.set(url, inflight);
  }
  return inflight;
}

/** Synchronous peek - the text if already warmed, else undefined. */
export function peekText(url: string): string | undefined {
  return textCache.get(url);
}

const jsonCache = new Map<string, unknown>();
const jsonInflight = new Map<string, Promise<unknown>>();

/** Fetch + parse JSON (e.g. a schematic manifest) once; repeat calls cache. */
export function fetchJsonCached<T>(url: string): Promise<T> {
  const hit = jsonCache.get(url);
  if (hit !== undefined) return Promise.resolve(hit as T);
  let inflight = jsonInflight.get(url);
  if (!inflight) {
    inflight = fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        jsonCache.set(url, data);
        jsonInflight.delete(url);
        return data;
      })
      .catch((err) => {
        jsonInflight.delete(url);
        throw err;
      });
    jsonInflight.set(url, inflight);
  }
  return inflight as Promise<T>;
}

/** Synchronous peek - the parsed JSON if already warmed, else undefined. */
export function peekJson<T>(url: string): T | undefined {
  return jsonCache.get(url) as T | undefined;
}

const imgPrefetched = new Set<string>();

/** Warm an image into the browser cache so a later <img src> paints instantly. */
const imgDecoded = new Set<string>();

export function prefetchImage(url: string, opts?: {decode?: boolean}): void {
  if (typeof Image === 'undefined') return;
  const wantDecode = Boolean(opts?.decode);
  // A byte-only warm must still be upgradeable to a decoded warm later (a
  // sibling tier prefetched without decode, then activated), so the dedupe
  // only short-circuits when this call adds nothing new.
  if (imgPrefetched.has(url) && (!wantDecode || imgDecoded.has(url))) return;
  imgPrefetched.add(url);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  // decode: true also decodes the bitmap now (off the main thread) so the
  // browser caches the decoded pixels; without it the first paint of a
  // warmed multi-megapixel sheet still paid its full decode during scroll.
  // Only request it for images that will actually paint soon - decoding a
  // whole sibling tier's sheaf just evicts the ones that matter from the
  // decoded-image cache. Best-effort: decode() rejects for broken images.
  if (wantDecode) {
    imgDecoded.add(url);
    img.decode?.().catch(() => {});
  }
}
