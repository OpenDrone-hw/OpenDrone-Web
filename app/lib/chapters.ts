/**
 * Product-page chapters, as data.
 *
 * Today the eight chapters are hand-written JSX in a fixed order, and
 * `computeChapterNumbers` walks the same predicates in a parallel function
 * whose own comment says "keep the two in step". Nothing enforced that. This
 * module replaces both: one ordered list is the single source of truth for
 * what renders, in what order, and therefore what number each chapter gets.
 * Numbering cannot drift from rendering because it is derived from the same
 * array the renderer walks.
 *
 * What is honestly possible here, and what is not.
 *
 * Most chapters are not generic content. The teardown alone drives about a
 * third of the product route: hover highlighting, pin grouping, a mobile part
 * tour, board preloading and animation timing. Contributors and Reviews have no
 * authorable content at all, being gated by the GitHub API and by Shopify
 * metafields. Pretending those could be expressed as "title, prose, image"
 * blocks would mean rebuilding them as something worse.
 *
 * So chapters are TYPED, and each type is backed by a real component. The data
 * controls which chapters exist, their order, whether each is on, and its
 * title. It does not control how a chapter draws itself. The one exception is
 * `prose`, a genuinely generic type the maintainer can add as many of as they like, whose
 * whole content comes from the copy store.
 */

/**
 * The chapter kinds the product route knows how to draw.
 *
 * Adding one means writing a component; this list is not user-extensible, and
 * that is the point. `prose` is the escape hatch for "I just want to say
 * something here", which is what "add a chapter" means in practice.
 */
export const CHAPTER_TYPES = [
  'whatIsThis',
  'openSource',
  'teardown',
  'specs',
  'inTheBox',
  'downloads',
  'firmware',
  'contributors',
  'reviews',
  'prose',
] as const;

export type ChapterType = (typeof CHAPTER_TYPES)[number];

export type ChapterEntry = {
  /**
   * Stable identity, unique within a product's list. Not the type: a page can
   * hold several `prose` chapters, and reordering must not renumber the wrong
   * one. Also what the studio drags around.
   */
  id: string;
  type: ChapterType;
  /**
   * Off, but not deleted. Hiding a chapter keeps its data, so turning it back
   * on is one click rather than a re-migration. Absent means on.
   */
  enabled?: boolean;
  /**
   * Overrides the type's built-in title. Titles were per-type constants baked
   * into the route; this makes them per-product without forcing every product
   * to restate them.
   */
  title?: string;
};

export type ChapterConfig = {
  /** Applies to every product that has no entry in `products`. */
  default: ChapterEntry[];
  /** Per-handle override of the whole list. */
  products?: Record<string, ChapterEntry[]>;
};

/**
 * The order shipped today, kept as code so a missing or unreadable config file
 * degrades to the designed page rather than to a blank one.
 *
 * Order is the argument the page makes: what this part even is, then what the
 * board is published as, then what it is made of, then what it measures, then
 * what ships, then who built it. Changing it in the studio changes the
 * argument, which is the point, but this is the version that was designed.
 */
export const DEFAULT_CHAPTERS: ChapterEntry[] = [
  // First on purpose: a first-time builder gets oriented before the page
  // starts arguing licenses and layer stacks. Professionals scroll past.
  {id: 'what-is-this', type: 'whatIsThis'},
  {id: 'open-source', type: 'openSource'},
  {id: 'teardown', type: 'teardown'},
  {id: 'specs', type: 'specs'},
  {id: 'in-the-box', type: 'inTheBox'},
  {id: 'downloads', type: 'downloads'},
  {id: 'firmware', type: 'firmware'},
  {id: 'contributors', type: 'contributors'},
  {id: 'reviews', type: 'reviews'},
];

/**
 * `import.meta.glob` only exists inside Vite's transform. Guarding on
 * `import.meta.env` lets this module also be imported by the node:test suites,
 * which run the TypeScript directly with no bundler: there, the guard is falsy,
 * the glob is never evaluated, and the built-in default order is used. Vite
 * still rewrites the call itself, so the real build is unaffected.
 *
 * Without this the whole module throws on import under `node --test`, which is
 * how the numbering rules below would have gone untested.
 */
const FILES = import.meta.env
  ? import.meta.glob<{default: ChapterConfig}>('/content/chapters.json', {
      eager: true,
    })
  : {};

const CONFIG: ChapterConfig = Object.values(FILES)[0]?.default ?? {
  default: DEFAULT_CHAPTERS,
};

/**
 * Reject anything malformed rather than rendering a broken page. A hand-edited
 * or half-written config should fall back to the designed order, not take the
 * product pages down: these files are committed, so a bad one would deploy.
 */
function valid(list: unknown): list is ChapterEntry[] {
  if (!Array.isArray(list) || list.length === 0) return false;
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== 'object') return false;
    const {id, type} = e as ChapterEntry;
    if (typeof id !== 'string' || !id) return false;
    if (!CHAPTER_TYPES.includes(type)) return false;
    // Duplicate ids would make the studio's drag-and-drop move the wrong row
    // and React's keys collide.
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** The chapter list for a product, before presence rules are applied. */
export function chaptersFor(handle: string | null | undefined): ChapterEntry[] {
  const override = handle ? CONFIG.products?.[handle] : undefined;
  if (valid(override)) return override;
  if (valid(CONFIG.default)) return CONFIG.default;
  return DEFAULT_CHAPTERS;
}

/**
 * Resolve the list against what this product actually has.
 *
 * `present` answers "does this chapter have anything to show", and stays in the
 * route because the answers come from three places the config cannot see:
 * whether the handle has an editorial entry at all, the product's lifecycle
 * status, and Shopify review metafields.
 *
 * Returns the chapters that will render, each with its number already assigned.
 * The renderer walks exactly this, so a chapter's number is by construction the
 * position it appears in.
 */
export function resolveChapters(
  handle: string | null | undefined,
  present: (type: ChapterType, entry: ChapterEntry) => boolean,
): Array<ChapterEntry & {number: string}> {
  const out: Array<ChapterEntry & {number: string}> = [];
  let n = 1;
  for (const entry of chaptersFor(handle)) {
    if (entry.enabled === false) continue;
    if (!present(entry.type, entry)) continue;
    out.push({...entry, number: String(n++).padStart(2, '0')});
  }
  return out;
}
