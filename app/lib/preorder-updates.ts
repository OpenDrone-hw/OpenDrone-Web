/**
 * Campaign updates for `/preorder`, read from
 * `content/copy/preorder-updates.json`.
 *
 * A list rather than the usual flat key/value copy file: an update is a
 * dated record that gets appended to, not a string that gets edited, and
 * numbering the keys by hand (`update_1_title`) is how a list ends up
 * renumbered wrongly the first time one is inserted. It still lives under
 * `content/copy/` so the studio's leaf walker reaches every string in it
 * (`app/studio/leaves.ts` flattens arrays by index).
 *
 * Newest first, always: the page has no other ordering and the file is
 * edited by hand, so the order in the file is not trusted.
 */

/** One dated entry. `date` is an ISO day, `body` one paragraph. */
export type PreorderUpdate = {
  date: string;
  title: string;
  body: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accept a parsed JSON body as the update list. Never throws: a body that
 * is not an array, or an entry missing a usable date, title or body, is
 * dropped. A page with no updates renders its empty state; a page that
 * throws renders nothing at all.
 */
export function parseUpdates(body: unknown): PreorderUpdate[] {
  if (!Array.isArray(body)) return [];
  const updates: PreorderUpdate[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const {date, title, body: text} = entry;
    if (typeof date !== 'string' || !ISO_DAY.test(date.trim())) continue;
    if (typeof title !== 'string' || !title.trim()) continue;
    if (typeof text !== 'string' || !text.trim()) continue;
    updates.push({date: date.trim(), title: title.trim(), body: text.trim()});
  }
  // ISO days sort correctly as strings, so no Date is constructed here and
  // no timezone can move an entry across a day boundary.
  return updates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Same guarded-glob pattern as app/lib/copy.ts: bundled for the worker,
// HMR-tracked for the studio, absent under node:test (no Vite, so no
// `import.meta.glob`), where `parseUpdates` is tested directly instead.
const FILES = import.meta.env
  ? import.meta.glob<{default: unknown}>('/content/copy/preorder-updates.json', {
      eager: true,
    })
  : {};

/** The update list, newest first. */
export function preorderUpdates(): PreorderUpdate[] {
  const file = Object.values(FILES)[0];
  return parseUpdates(file?.default);
}
