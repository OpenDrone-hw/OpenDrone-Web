import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {AnimationEvent as ReactAnimationEvent, CSSProperties} from 'react';

// useLayoutEffect on the server logs a warning; fall back to useEffect there.
// The board swap it drives is a client-only interaction, so this never matters
// functionally - it just silences the SSR noise.
const useIsoLayoutEffect =
  typeof document !== 'undefined' ? useLayoutEffect : useEffect;
import {
  fetchJsonCached,
  fetchTextCached,
  peekJson,
  peekText,
  prefetchImage,
} from '~/lib/asset-prefetch';
import {BOARD_ART_VERSION} from '~/data/board-art-version';
import {assetUrl} from '~/lib/asset-url';
import {useIsMobile} from '~/lib/use-media-query';
import {useLayerSwipe} from '~/lib/use-layer-swipe';
import {
  SWAP_TIMING,
  layerSweepDelays,
  swapInDelayS,
  swapSettleBackstopMs,
} from '~/lib/board-swap-timing';

// `?v=` busts Oxygen's 1-year immutable cache when board art is regenerated in
// place - the token is the content hash of every board.svg, board-lite.svg,
// front/back PNG and derived WebP under public/boards, baked into the bundle
// by scripts/export-board-art.mjs. We version BOTH the svg fetch URL AND every
// <image> href it references, so a re-render (e.g. an IC-less → IC-full face,
// or a raster re-export) refetches both the markup and the bitmaps instead of
// serving the stale cached render forever.
const versioned = (url: string) =>
  BOARD_ART_VERSION ? `${url}?v=${BOARD_ART_VERSION}` : url;

// The stack renders board-lite.svg, not board.svg: same layer groups, but each
// copper layer's thousands of vector paths are replaced by ONE <image> of a
// lossless WebP raster that scripts/export-board-art.mjs pre-rendered with
// headless Chromium. Six vector sheets behind CSS filters and transform
// transitions re-rasterised on every frame of the layer sweep and stuttered on
// phones; a bitmap sheet is decoded once and just composited. board.svg stays
// the fallback for a board that has not been re-exported with rasters.
const liteSrc = (src: string) => src.replace(/board\.svg$/, 'board-lite.svg');
async function fetchBoardText(src: string): Promise<string> {
  const lite = liteSrc(src);
  if (lite === src) return fetchTextCached(versioned(src));
  try {
    return await fetchTextCached(versioned(lite));
  } catch {
    return fetchTextCached(versioned(src));
  }
}
// Rasters ship at 1280 px (desktop) and 1024 px (phones); the faces at 1568 px
// PNG (desktop) and 1024 px WebP (phones). A phone stack is under 400 CSS px,
// so 1024 px is still 2.5x oversampled there while decoding a quarter of the
// pixels. Decided once per parse (the parsed sheets are cached per src), so a
// window resized across the threshold keeps its first choice until reload.
const SMALL_STACK_QUERY = '(max-width: 900px)';
function smallStack(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(SMALL_STACK_QUERY).matches
  );
}
function sizedHref(href: string, small: boolean, lite: boolean): string {
  // The WebP faces are written by the same export step as the rasters, so
  // only a board that HAS board-lite.svg has them; the board.svg fallback
  // keeps its full-size PNG faces. Desktop takes the 1280 px lossy WebP face
  // (the stack is at most ~590 CSS px, 2x = 1180 px) instead of the 1568 px
  // PNG (394 + 684 KB per board); phones the 1024 px one.
  if (lite) {
    href = href.replace(
      /\/(front|back)\.png$/,
      small ? '/$1-w1024.webp' : '/$1-w1280.webp',
    );
  }
  return small ? href.replace(/-w1280\.webp$/, '-w1024.webp') : href;
}
/**
 * Warm a board's bytes for a later visit: the layered SVG text and every
 * raster it references, at the size this screen will use, into the network
 * cache. No DOMParser, no decode and no layout, so it costs the main thread
 * nothing; the expensive build still happens when the board nears the view.
 */
export async function warmBoardBytes(src: string): Promise<void> {
  const text = await fetchBoardText(src);
  const small = smallStack();
  const lite = text.includes('-w1280.webp');
  for (const m of text.matchAll(/(?:xlink:)?href="([^"]+\.(?:webp|png))"/g)) {
    const href = m[1];
    if (href.includes('?v=')) continue;
    prefetchImage(assetUrl(versioned(sizedHref(href, small, lite))));
  }
}

/** Synchronous cache peek matching {@link fetchBoardText}: lite first, then
 *  the board.svg fallback, so a remount of a warmed board seeds from cache. */
const peekBoardText = (src: string) =>
  peekText(versioned(liteSrc(src))) ?? peekText(versioned(src));

export type BoardArtProps = {
  /** Public path to the layered SVG, e.g. /boards/openesc/board.svg */
  src: string;
  /** Every tier's board SVG, so siblings can be warmed in the background and
   *  a variant toggle swaps in with no network and no blank frame. */
  srcs?: string[];
  /** Optional handle used for analytics / data attributes. */
  handle?: string;
  /** Optional "Inspect interactively" deep-dive link (e.g. KiCanvas hosted). */
  inspectUrl?: string;
  /** Per-layer function blurbs keyed by copper-layer slug (`f`, `in1`…`b`),
   *  shown beside each name in the rail. Slugs left unset fall back to a
   *  position-based guess (see {@link layerFunction}). */
  layerFns?: Record<string, string>;
  /** Public path to the component manifest (`components.json`) for the active
   *  board. Fetched lazily; when a `highlightRefs` ref matches a component its
   *  footprint is drawn as a gold highlight over the active sheet. */
  componentsSrc?: string;
  /** Refdes (case-sensitive) to highlight on the board - typically the refs of
   *  the teardown pin the visitor is hovering/focusing. */
  highlightRefs?: string[];
  /** When true, draw ONE box around the union of all `highlightRefs` instead of a
   *  box per refdes - for dense arrays (e.g. the bulk ceramic-cap grid). */
  highlightUnion?: boolean;
  /** Draw one union box per subarray (e.g. ESC motor pads grouped by motor → 4
   *  boxes). Each entry is a list of refdes; takes precedence over union/each. */
  highlightGroups?: string[][];
  /** Called with `true` while the first-reveal fly-in is animating and `false`
   *  when it finishes, so the parent can lock part-list interaction meanwhile. */
  onFlying?: (active: boolean) => void;
  /** Reports whether a part highlight is actually drawn on the visible layer, so
   *  the parent's tap-toggle can re-assert a part hidden behind another layer
   *  instead of toggling it off invisibly. */
  onHighlightVisible?: (visible: boolean) => void;
  /** Fired once when a variant swap's fly-out/fly-in begins (gen = swap id), so
   *  the parent can dip the parts list + retract the connector wires in lockstep
   *  with the board - no independent timers. Also fired for the reduced-motion /
   *  non-desktop hard-cut, immediately followed by {@link onSwapSettle}. */
  onSwapStart?: (gen: number) => void;
  /** Fired once when the swap has fully settled (all fly-out animations ended, or
   *  the hard-cut), so the parent can finalise the list + redraw the wires to the
   *  new board's bubbles. */
  onSwapSettle?: (gen: number) => void;
};

/** One component from `components.json` - coords already in the board viewBox. */
type BoardComponent = {
  ref: string;
  layer?: string;
  bbox?: {x: number; y: number; w: number; h: number};
  courtyard?: Array<[number, number]>;
};
type BoardManifest = {viewBox?: string; components?: BoardComponent[]};

/** Module cache of parsed component manifests, keyed by componentsSrc. */
const manifestCache = new Map<
  string,
  {viewBox: string; map: Map<string, BoardComponent>}
>();

function parseManifest(raw: unknown): {
  viewBox: string;
  map: Map<string, BoardComponent>;
} {
  const m = (raw ?? {}) as BoardManifest;
  const map = new Map<string, BoardComponent>();
  for (const c of m.components ?? []) {
    if (c?.ref) map.set(c.ref, c);
  }
  return {viewBox: m.viewBox ?? '', map};
}

/**
 * Short function blurb for a copper layer. A content-supplied `override` wins;
 * otherwise guess from the layer's position in the stack - the outermost pair
 * carries signals + components, the pair just inside them is almost always a
 * solid reference (ground) plane, and everything between is signal + power.
 */
function layerFunction(
  slug: string,
  index: number,
  total: number,
  override?: Record<string, string>,
): string {
  if (override?.[slug]) return override[slug];
  // The realistic composite faces describe the physical board side, not a
  // copper stack position, so they must not get the position-based guess.
  // Both faces carry components on these boards (double-sided SMT).
  if (slug === 'front') return 'Component side';
  if (slug === 'back') return 'Component side';
  // The position guess applies to the copper sheets only. Front sits at index 0
  // and back at index total-1, so exclude those ends from the copper logic by
  // measuring position within the copper run (front=1st sheet, back=last).
  const copperFirst = index === 1; // first copper sheet (after front)
  const copperLast = index === total - 2; // last copper sheet (before back)
  if (copperFirst || copperLast) return 'Signal + components';
  if (index === 2 || index === total - 3) return 'Ground plane';
  return 'Signal + power';
}

/** Human label for each known layer slug, in physical top→bottom order. */
const LAYER_LABELS: Record<string, string> = {
  front: 'Top',
  f: 'Top Cu',
  in1: 'In1',
  in2: 'In2',
  in3: 'In3',
  in4: 'In4',
  b: 'Bottom Cu',
  back: 'Bottom',
  // legacy 3-layer boards (export-board-art.mjs pre-folder)
  copper: 'Top',
  'b-copper': 'Bottom',
};

/** Folder stack order: realistic front first, the copper stack top→bottom, the
 *  realistic back last. Any unknown layer slug falls in after the knowns. */
const SHEET_ORDER = ['front', 'f', 'in1', 'in2', 'in3', 'in4', 'b', 'back'];

type Sheet = {slug: string; label: string; html: string};

/**
 * Module-level cache of parsed layer sheets, keyed by board SVG src. Splitting
 * the board SVG with DOMParser used to be the expensive step (~1 s for a
 * multi-MB vector board.svg; board-lite.svg is ~20 KB, so it is cheap now but
 * still not free) and used to re-run on every variant click. Caching the parsed
 * result, and pre-parsing sibling tiers in the background the moment the
 * section is in view, turns a tier switch into an instant cache hit instead of
 * a fetch + parse.
 */
const parsedCache = new Map<string, Sheet[]>();

/** Split the multi-layer board SVG into one sheet per copper layer. */
function parseSheets(raw: string): Sheet[] {
  if (!raw || typeof DOMParser === 'undefined') return [];
  try {
    const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return [];
    const viewBox = svg.getAttribute('viewBox') ?? '';
    const defs = svg.querySelector('defs')?.outerHTML ?? '';
    const edgeInner = doc.getElementById('layer-edge-cuts')?.innerHTML ?? '';
    // The folder shows the realistic faces (front/back) plus every copper layer;
    // `layer-edge-cuts` is the outline, drawn as a faint underlay, never a sheet.
    const layers = Array.from(svg.querySelectorAll('[id^="layer-"]')).filter(
      (g) => g.id !== 'layer-edge-cuts',
    ) as SVGElement[];
    // Order front → copper(f,in1…b) → back; unknown slugs sort after the knowns.
    layers.sort((a, b) => {
      const ia = SHEET_ORDER.indexOf(a.id.replace(/^layer-/, ''));
      const ib = SHEET_ORDER.indexOf(b.id.replace(/^layer-/, ''));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // Version every <image> href (the faces and, in board-lite.svg, the copper
    // rasters) so a re-render busts their immutable cache too - the same
    // content hash as the svg fetch, so markup and bitmaps refetch together.
    // Done on the parsed DOM before serialization. sizedHref also picks the
    // WebP face and the raster width for the screen, and assetUrl points the
    // bitmap at the CDN (the site origin re-encodes bitmaps as PNG).
    const small = smallStack();
    const lite = Boolean(svg.querySelector('image[href*="-w1280.webp"]'));
    for (const img of Array.from(svg.querySelectorAll('image'))) {
      const href = img.getAttribute('href') ?? img.getAttribute('xlink:href');
      if (href && !href.includes('?v=')) {
        const v = assetUrl(versioned(sizedHref(href, small, lite)));
        if (img.hasAttribute('href')) img.setAttribute('href', v);
        if (img.hasAttribute('xlink:href')) img.setAttribute('xlink:href', v);
      }
    }
    return layers.map((g) => {
      const slug = g.id.replace(/^layer-/, '');
      // The realistic faces have baked colours and an opaque board background;
      // the faint edge underlay would be hidden behind them, so skip it (and
      // tag the sheet so CSS can opt them out of any copper-only treatment).
      const isFace = slug === 'front' || slug === 'back';
      const edge = isFace ? '' : `<g class="board-sheet-edge">${edgeInner}</g>`;
      const faceClass = isFace ? ` board-sheet-svg-${slug}` : '';
      return {
        slug,
        label: LAYER_LABELS[slug] ?? slug.toUpperCase(),
        html:
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ` +
          `preserveAspectRatio="xMidYMid meet" class="board-sheet-svg${faceClass}">` +
          `<defs>${defs}</defs>` +
          `${edge}` +
          `${g.outerHTML}</svg>`,
      };
    });
  } catch {
    return [];
  }
}

/** Fetch (text-cached) and parse a board SVG into {@link parsedCache}, so a
 *  later switch to it renders with no network and no parse. */
async function warmParsed(src: string): Promise<Sheet[]> {
  const hit = parsedCache.get(src);
  if (hit) return hit;
  // Fetch the versioned URL (shared asset cache key) but key parsedCache by the
  // bare src so the rest of the component addresses boards by their stable path.
  const text = await fetchBoardText(src);
  const existing = parsedCache.get(src);
  if (existing) return existing;
  const parsed = parseSheets(text);
  if (parsed.length) parsedCache.set(src, parsed);
  return parsed;
}

/**
 * Render every copper layer of a KiCad board as a stack of sheets in a folder.
 *
 * The asset is one SVG (scripts/export-board-art.mjs) with a `<g id="layer-…">`
 * per copper layer plus `layer-edge-cuts` as the board outline. We split it into
 * one self-contained `<svg>` "sheet" per copper layer - each carries the shared
 * clip + a faint board silhouette + that one layer's copper. CSS fans the sheets
 * back like files in a folder; selecting a layer floats its sheet up and forward.
 *
 * Fetched lazily (only as the section nears the viewport).
 */
/** A frozen capture of the board being flown OUT - its own sheets + the layer
 *  index that was showing - so the outgoing stack renders from pure props and can
 *  never be perturbed by live state (the active-index clamp, a hover, etc.). */
type SwapSnapshot = {sheets: Sheet[]; shownIndex: number};
/** The variant-swap finite state machine. Generation-counted: every run gets a
 *  unique `gen`; animationend events and the backstop are tagged with it, so a
 *  superseded run's stragglers are dropped. Replaces the old ghost/innerHTML/
 *  ref-guard/wall-clock-timer machinery wholesale. */
type SwapState = {
  phase: 'idle' | 'run';
  gen: number;
  /** The src the FSM currently treats as live (settled or being flown in). */
  committedSrc: string;
  outgoing: SwapSnapshot | null;
  /** board-swap-IN animationend events expected this run = the NEW board's layer
   *  count (1 for the mobile whole-board slide). The swap settles when the
   *  incoming has fully landed (it's the LAST phase), not when the outgoing left.
   *  Captured at START so a near-breakpoint resize can't desync count from CSS. */
  expected: number;
  /** Outgoing layer count - drives the incoming's --swap-in-delay (so the new
   *  board waits for the old to leave) and the settle backstop. */
  outCount: number;
  remaining: number;
};
type SwapAction =
  | {
      type: 'START';
      src: string;
      outgoing: SwapSnapshot;
      expected: number;
      outCount: number;
    }
  | {type: 'RETARGET'; src: string}
  | {type: 'HARDCUT'; src: string}
  | {type: 'EVENT'; gen: number}
  | {type: 'SETTLE'; gen: number};

function swapReducer(state: SwapState, action: SwapAction): SwapState {
  switch (action.type) {
    case 'START':
      // Idempotent: a duplicate dispatch for an already-committed src (React
      // StrictMode double-invoke) is a no-op - the prior action in the queue has
      // already moved committedSrc forward.
      if (action.src === state.committedSrc) return state;
      return {
        phase: 'run',
        gen: state.gen + 1,
        committedSrc: action.src,
        outgoing: action.outgoing,
        expected: action.expected,
        outCount: action.outCount,
        remaining: action.expected,
      };
    case 'RETARGET':
      // src changed mid-run; the live stack already follows src, so just record
      // the new target and let the running fly-out finish (no 2nd outgoing).
      if (action.src === state.committedSrc) return state;
      return {...state, committedSrc: action.src};
    case 'HARDCUT':
      if (action.src === state.committedSrc) return state;
      return {
        ...state,
        phase: 'idle',
        gen: state.gen + 1,
        committedSrc: action.src,
        outgoing: null,
        expected: 0,
        outCount: 0,
        remaining: 0,
      };
    case 'EVENT': {
      if (action.gen !== state.gen || state.phase !== 'run') return state;
      const remaining = state.remaining - 1;
      if (remaining > 0) return {...state, remaining};
      return {...state, phase: 'idle', outgoing: null, remaining: 0};
    }
    case 'SETTLE':
      // Backstop force-settle (a dropped animationend, e.g. a backgrounded tab).
      if (action.gen !== state.gen || state.phase !== 'run') return state;
      return {...state, phase: 'idle', outgoing: null, remaining: 0};
    default:
      return state;
  }
}

export function BoardArt({
  src,
  srcs,
  handle,
  inspectUrl,
  layerFns,
  componentsSrc,
  highlightRefs,
  highlightUnion,
  highlightGroups,
  onFlying,
  onHighlightVisible,
  onSwapStart,
  onSwapSettle,
}: BoardArtProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  // Instance-unique suffix for the spotlight SVG ids, so two mounted BoardArts
  // can never collide on `od-dim`/`od-bright`/`od-spot` (SVG id resolution would
  // otherwise pick the first in document order → wrong board masked).
  const uid = useId().replace(/:/g, '');
  // Whether the previous render already had a highlight group on the board - so a
  // row-to-row move (highlight→highlight) skips the fade-in and just repositions
  // the spotlight, while a fresh entry (none→highlight) still fades in.
  const hadHilite = useRef(false);
  // One spotlight group per board FACE (keyed by that face's <svg> node), built
  // ONCE and then only repositioned/hidden. Re-cloning the board <image> on
  // every hover - to dim + re-light the board - is what flashed the spotlight;
  // caching per face means the dim veil and the decoded image clone are never
  // rebuilt, so neither a row-to-row move nor a front/back flip can flash. The
  // group is hidden (not destroyed) when nothing is highlighted, so re-entering
  // the list is instant too. Entries whose <svg> leaves the DOM (tier swap) are
  // pruned each run.
  const spotCache = useRef<
    Map<Element, {g: Element; brightClip: Element | null}>
  >(new Map());
  // `raw` is the SVG text currently on screen. Seed from cache so a tier that
  // was warmed earlier paints immediately with no blank frame.
  const [raw, setRaw] = useState<string | null>(
    () => peekBoardText(src) ?? null,
  );
  const [revealed, setRevealed] = useState<boolean>(
    () => peekBoardText(src) != null,
  );
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [inView, setInView] = useState(false);
  const isMobile = useIsMobile();
  // True while a variant swap is mid-flight. The rail-placement effect reads the
  // active sheet's box to position the layer textbox; measuring it WHILE the new
  // board is flying in (translated off to the side) placed the rail wrong and
  // made it jump. So we hold the rail where it is during the swap and re-place it
  // once - via `placeNonce` - when the swap has settled.
  const swapActiveRef = useRef(false);
  const [placeNonce, setPlaceNonce] = useState(0);
  // Which src the current `raw` text belongs to, and the last non-empty parsed
  // board - so a tier switch keeps the prior board on screen until the new one
  // is parsed, and never re-parses a board the cache already holds.
  const rawSrcRef = useRef<string | null>(
    peekBoardText(src) != null ? src : null,
  );
  const lastSheetsRef = useRef<Sheet[]>([]);
  // Parsed component manifest for the active board (viewBox + ref→component
  // map). Seeded from cache so a warmed tier highlights with no fetch.
  const [manifest, setManifest] = useState<{
    viewBox: string;
    map: Map<string, BoardComponent>;
  } | null>(() => {
    if (!componentsSrc) return null;
    const cached = manifestCache.get(componentsSrc);
    if (cached) return cached;
    const peeked = peekJson(componentsSrc);
    return peeked ? parseManifest(peeked) : null;
  });

  // Lazy gate: fetch nothing until the section nears the viewport. The margin
  // is generous (2 viewports-ish) and an idle fallback arms it a few seconds
  // after load regardless: fetching + DOMParser-splitting a multi-MB SVG and
  // laying out its ~30k paths lands as ONE huge frame if it happens while the
  // user is actively scrolling into it (measured: a 1.1s frame at 4x CPU
  // right at this section). Front-loading it into idle time keeps the scroll
  // clean; the network/parse caches make the early work free to repeat.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io.disconnect();
            setInView(true);
            return;
          }
        }
      },
      {rootMargin: '1800px 0px', threshold: 0.01},
    );
    io.observe(el);
    // Idle fallback: warm only the BYTES (network cache) for a visitor who
    // parks above the fold, so their eventual scroll pays parse+layout with
    // the fetch already local - the expensive DOM build stays behind the
    // IntersectionObserver. Full-building here forced every PDP visit to
    // download AND lay out the multi-MB SVG even when the visitor never
    // scrolls near it; on top of that, rIC's timeout fires mid-scroll, so
    // building from here could land the build inside the scroll anyway.
    // Skipped entirely for data-saver visitors.
    const conn = (navigator as any).connection;
    const frugal = Boolean(
      conn?.saveData || /(^|\b)2g/.test(String(conn?.effectiveType ?? '')),
    );
    const ric = (window as any).requestIdleCallback;
    const warmBytes = () => {
      void fetchBoardText(src).catch(() => {});
    };
    const idleId = frugal
      ? null
      : typeof ric === 'function'
        ? ric(warmBytes, {timeout: 6000})
        : window.setTimeout(warmBytes, 4000);
    return () => {
      io.disconnect();
      if (idleId == null) return;
      const cancel = (window as any).cancelIdleCallback;
      if (typeof ric === 'function' && typeof cancel === 'function')
        cancel(idleId);
      else window.clearTimeout(idleId as number);
    };
    // src is stable for the mounted board; a variant swap re-fetches through
    // its own cached path, so re-arming the warm on src change buys nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazily fetch + parse the component manifest for the active board (reuses the
  // shared JSON cache + a parsed-manifest cache), so hovering a teardown pin can
  // resolve refdes → footprint geometry without a per-hover round-trip.
  useEffect(() => {
    if (!inView || !componentsSrc) return;
    const cached = manifestCache.get(componentsSrc);
    if (cached) {
      setManifest(cached);
      return;
    }
    let alive = true;
    fetchJsonCached<unknown>(componentsSrc)
      .then((data) => {
        if (!alive) return;
        const parsed = manifestCache.get(componentsSrc) ?? parseManifest(data);
        manifestCache.set(componentsSrc, parsed);
        setManifest(parsed);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [inView, componentsSrc]);

  // Load the active board once in view and warm every sibling tier in the
  // background. The previously shown board stays on screen until the new SVG
  // resolves, so a tier toggle swaps cleanly instead of flashing empty.
  useEffect(() => {
    if (!inView) return;
    let alive = true;
    fetchBoardText(src)
      .then((text) => {
        if (!alive) return;
        // Parse + cache the active board if not already cached, so the memo
        // serves it (and any later return to it) instantly.
        const parsed = parsedCache.get(src) ?? parseSheets(text);
        if (parsed.length) parsedCache.set(src, parsed);
        rawSrcRef.current = src;
        setRaw(text);
        setFailed(parsed.length === 0);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [inView, src]);

  // Fade the board in once its SVG is in hand - driven off `raw`, not the fetch
  // effect's `alive` flag. A large SVG's parse can block the main thread long
  // enough that an effect re-run (e.g. a fresh `srcs` array) flips `alive` false
  // before a reveal scheduled inside the fetch effect ever fires, leaving the
  // board stuck at opacity 0. Keying on `raw` makes the reveal independent.
  useEffect(() => {
    if (raw == null) return;
    const r = requestAnimationFrame(() =>
      requestAnimationFrame(() => setRevealed(true)),
    );
    return () => cancelAnimationFrame(r);
  }, [raw]);

  // Compositor pre-warm, one gate ahead of the fly. The entrance animates
  // `translate` on every sheet, and until now nothing promoted them: frame 0 of
  // the fly paid layer creation AND first raster for the whole stack, which is
  // exactly the stutter `.is-swap-ready` was added to avoid for the *swap*
  // ("promoting at swap start drops the first frames"). The entrance deserves
  // the same trade.
  //
  // Deliberately NOT tied to `is-armed`: arming happens as soon as the SVG
  // parses, which on a desktop viewport is during page load, so promoting there
  // would hand every visitor a stack of GPU layers whether or not they ever
  // scroll this far. This observer fires ~a viewport before the centre-band fly
  // trigger instead, which since the schematic chapter moved ahead of the
  // teardown is a real window of approach: the layers exist and are rastered by
  // the time the animation starts, and a visitor who never gets here pays
  // nothing. Skipped under reduced motion, where the fly does not run at all.
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    // Wait for `revealed`: before the sheets exist the chapter is collapsed to
    // its skeleton height and this element sits near the top of the document,
    // so a one-shot observer attached then fires immediately and promotes at
    // load - the exact thing this gate exists to avoid. Once the board is built
    // the element has its real box and the margin means what it says.
    if (warm || !revealed) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setWarm(true);
        }
      },
      {rootMargin: '800px 0px', threshold: 0},
    );
    io.observe(el);
    return () => io.disconnect();
  }, [warm, revealed]);

  // Trigger the layer fly-in only once the board reaches the centre band of the
  // viewport (not the moment the chapter scrolls in) so it reads as a deliberate
  // reveal. One-shot; the sheets sit off-screen (paused) until it fires.
  const [flyIn, setFlyIn] = useState(false);
  // Re-armable: deps on flyIn so that when a swap-while-off-screen resets flyIn to
  // false (see the swap driver), the centre-band observer re-attaches and the
  // entrance replays the next time the board scrolls back into the centre.
  useEffect(() => {
    if (flyIn) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setFlyIn(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          setFlyIn(true);
        }
      },
      {rootMargin: '-38% 0px -38% 0px', threshold: 0},
    );
    io.observe(el);
    return () => io.disconnect();
  }, [flyIn]);

  // Live "is the board roughly on screen" flag (NOT one-shot). A SKU swap that
  // happens while this is false is not worth animating (the user is looking
  // elsewhere on the page) - the driver hard-cuts it and re-arms the entrance so
  // the reveal plays fresh when they scroll back. Cheap: a ref, no re-render.
  const visibleRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      visibleRef.current = true;
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        visibleRef.current = e.isIntersecting;
      },
      {rootMargin: '-15% 0px -15% 0px', threshold: 0},
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // `flyDone` ends the entrance: it strips the animation so a SKU swap (the
  // component stays mounted, new sheets inherit the classes) shows the new board
  // instantly at full scale instead of re-flying. While the fly runs we tell the
  // parent (to lock part selection) and the CSS drops the heavy filters.
  const [flyDone, setFlyDone] = useState(false);
  // The layer rail fades in DURING the entrance - 0.5s before the fly fully
  // settles - instead of waiting for flyDone, so it reads a beat sooner.
  const [railIn, setRailIn] = useState(false);
  useEffect(() => {
    if (!flyIn || flyDone) return;
    // Honour reduced-motion: no animation, no lock - settle immediately.
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      setFlyDone(true);
      setRailIn(true);
      return;
    }
    onFlying?.(true);
    // animation 1.2s + last layer's stagger (7 × 0.11s) + a small buffer
    const FLY_MS = 1200 + 7 * 110 + 250;
    const railT = setTimeout(() => setRailIn(true), Math.max(0, FLY_MS - 500));
    const t = setTimeout(() => {
      setFlyDone(true);
      onFlying?.(false);
    }, FLY_MS);
    return () => {
      clearTimeout(railT);
      clearTimeout(t);
    };
  }, [flyIn, flyDone, onFlying]);

  // Pre-parse sibling tiers ONLY after the entrance finishes - parsing every
  // other board's multi-thousand-path SVG is heavy main-thread work that, if it
  // landed mid-fly, janked the compositor animation. Deferring it to flyDone
  // gives the entrance the main thread to itself; the warm still lands long
  // before a tier click.
  useEffect(() => {
    if (!flyDone || !srcs) return;
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      for (const s of srcs) {
        if (s !== src && !parsedCache.has(s))
          void warmParsed(s).catch(() => {});
      }
    };
    const id: number =
      typeof requestIdleCallback !== 'undefined'
        ? requestIdleCallback(warm, {timeout: 1500})
        : (setTimeout(warm, 250) as unknown as number);
    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback !== 'undefined') cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, [flyDone, srcs, src]);

  // Resolve the layer sheets for the active board: a cache hit (the active board
  // or a pre-parsed sibling) renders instantly; otherwise parse the freshly
  // fetched text for THIS src; while a not-yet-parsed tier is loading, keep the
  // prior board on screen instead of flashing empty.
  const sheets = useMemo<Sheet[]>(() => {
    const cached = parsedCache.get(src);
    if (cached) {
      lastSheetsRef.current = cached;
      return cached;
    }
    if (rawSrcRef.current === src && raw) {
      const parsed = parseSheets(raw);
      if (parsed.length) {
        parsedCache.set(src, parsed);
        lastSheetsRef.current = parsed;
      }
      return parsed;
    }
    return lastSheetsRef.current;
  }, [src, raw]);

  // Keep the active index in range when sheets (re)load.
  useEffect(() => {
    if (sheets.length && active >= sheets.length) setActive(0);
  }, [sheets, active]);

  // Fit the layer rail into the gutter between the teardown copy and the board,
  // measuring where the *text* and the *board* actually are (not their grid
  // columns). The board is blown up past its column and bleeds left for drama,
  // so its visible left edge sits at/past the text column's right edge - but the
  // copy at the rail's vertical level rarely fills that column, leaving a real
  // gutter to its right. Priority, matching how a reader expects it to degrade:
  //   1. Full rail centred in the gutter, clear of both copy and board (the
  //      roomy default - wide screens).
  //   2. When the gutter is too tight for the full pill, drop the rail to
  //   3. When even the names-only pill can't fit, floor it at the copy (so it
  //      never crosses the text) and let it overlay the board's edge - the
  //      last-resort overlay.
  // Re-runs (rAF-coalesced) on resize; the active sheet's settled left edge is
  // the same for every layer, so we don't key it on `active` (which would
  // measure mid-float-animation).
  useEffect(() => {
    const rail = railRef.current;
    const body = bodyRef.current;
    const root = ref.current;
    if (!rail || !body || !root) return;
    const GAP = 18; // clearance between the rail and the board's left edge
    const MARGIN = 22; // clearance between the rail and the text content
    const DEFAULT_W = 2.2; // board blow-up factor at full size (matches CSS)
    const chapter = root.closest('.chapter');
    const leftOf = (el: Element) => el.getBoundingClientRect().left;
    const widthOf = (el: Element) => el.getBoundingClientRect().width;
    const setBoardW = (w: number) =>
      root.style.setProperty('--board-w', `${w * 100}%`);
    // Rightmost edge of the teardown copy that sits at the RAIL'S vertical level
    // - a Range gives the tight text bounds (longest wrapped line), not the full
    // column box. The rail floats centred on the board, BELOW the chapter title:
    // on a narrow viewport that title wraps wide (its right edge runs ~180px past
    // the component list) but it ends well above the rail, so it shares no
    // horizontal lane with it. Counting it shoved the rail onto the board even
    // though the real gutter (component list → board) was wide open. So skip any
    // copy whose vertical span sits entirely outside [bandTop, bandBottom].
    const contentRight = (bandTop: number, bandBottom: number) => {
      const els = chapter?.querySelectorAll(
        '.chapter-title, .chapter-body, .teardown-pins li, .board-art-inspect',
      );
      if (!els?.length) {
        const col = chapter?.querySelector('.chapter-body-col');
        return col?.getBoundingClientRect().right ?? -Infinity;
      }
      let max = -Infinity;
      for (const el of els) {
        const box = el.getBoundingClientRect();
        if (box.bottom <= bandTop || box.top >= bandBottom) continue;
        const range = document.createRange();
        range.selectNodeContents(el);
        const rect = range.getBoundingClientRect();
        if (rect.width) max = Math.max(max, rect.right);
      }
      return max;
    };
    // Layout box in document coordinates from the offset chain: it ignores
    // every CSS transform and translate, so it reads the same final answer
    // mid-fly, mid-swap and settled. Placing from it means the board and the
    // rail are set to their resting spot the moment a board mounts, instead
    // of being measured again (and jumping) once the motion ends.
    const docBox = (el: HTMLElement) => {
      let x = 0;
      let y = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
        x += n.offsetLeft;
        y += n.offsetTop;
      }
      return {x, y, w: el.offsetWidth, h: el.offsetHeight};
    };
    const place = () => {
      // Below the breakpoint the rail is a full-width top bar - reset both.
      if (!window.matchMedia('(min-width: 1025px)').matches) {
        rail.style.transform = '';
        root.style.removeProperty('--board-w');
        root.style.removeProperty('translate');
        return;
      }
      setBoardW(DEFAULT_W); // the board stays at full size; the rail takes what is left
      // The LIVE stack only - never the outgoing (.board-swap-out) one.
      const stack = body.querySelector<HTMLElement>('[data-role="live"]');
      if (!stack) return;
      const st = docBox(stack);
      if (!st.w || !st.h) return;
      // Where the active sheet rests, from the sheet's resting transform model:
      // letterboxed in the square stack by the board's viewBox aspect, then
      // translateY(-11%) translateZ(120px) scale(1.05) under the stack's 1700px
      // perspective, so it projects at 1.05 * 1700/(1700-120) about the centre.
      const anySvg = stack.querySelector<SVGSVGElement>('.board-sheet svg');
      const vb = anySvg?.viewBox?.baseVal;
      const aspect = vb && vb.height ? vb.width / vb.height : 1;
      const PROJ = 1700 / (1700 - 120);
      const S = 1.05 * PROJ;
      const cx = st.x + st.w / 2;
      const cy = st.y + st.h / 2 - st.h * 0.11 * PROJ;
      const drawnW = Math.min(st.w, st.h * aspect) * S;
      const drawnH = drawnW / aspect;
      // Repo-scope alignment: the visible board's top-right corner sits just
      // inside the outline's top-right border (maintainer, 2026-08-12).
      let dx = 0;
      let dy = 0;
      const scope = root.closest<HTMLElement>('.chapter[data-repo-scope]');
      if (scope && anySvg) {
        const sc = docBox(scope);
        const INSET = 12; // px inside the outline's border
        dx = sc.x + sc.w - INSET - (cx + drawnW / 2);
        dy = sc.y + INSET - (cy - drawnH / 2);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) dx = dy = 0;
      }
      if (dx || dy) root.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
      else root.style.removeProperty('translate');
      // Rail: centred in the gutter between the copy and the board's visible
      // left edge, in document x. The rail lives inside the translated root.
      const boardLeft = cx - drawnW / 2 + dx;
      const railBox = docBox(rail);
      const railLeft = railBox.x + (root.contains(rail) ? dx : 0);
      const railFull = railBox.w;
      // The stack box is the rail's vertical anchor; inset the band from its top
      // so a chapter title dipping into it is not counted as copy in the lane.
      const topVp = st.y + dy - window.scrollY;
      const bandTop = topVp + st.h * 0.1;
      const textRight = contentRight(bandTop, topVp + st.h) + window.scrollX;
      const gutterStart = textRight + MARGIN; // nearest the rail may sit to the copy
      const gutterEnd = boardLeft - GAP; // nearest the rail may sit to the board
      // Hug the board: the rail sits GAP left of the board's visible edge, so it
      // depends only on the board (known the moment it mounts) and travels with
      // it on a swap. Only copy that reaches into that spot pushes it right,
      // floored at the copy, overlapping the board edge as a last resort.
      const target = Math.max(gutterStart, gutterEnd - railFull);
      rail.style.transform = `translateX(${Math.round(target - railLeft)}px)`;
    };
    // Coalesce resize bursts into one placement per frame - `place` forces a
    // handful of layout reads against the large board SVG.
    let scheduled = 0;
    const schedule = () => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        place();
      });
    };
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      if (scheduled) cancelAnimationFrame(scheduled);
      window.removeEventListener('resize', schedule);
    };
    // flyIn: measure again the moment the entrance starts. The first run can
    // happen while the chapter above is still settling, and a stale offset
    // made the board land and then jump a few pixels when flyDone re-measured.
  }, [sheets, revealed, flyIn, flyDone, placeNonce]);

  // The index/refs actually rendered - the manual layer + tap/swipe-driven
  // highlight.
  const shownIndex = active;
  const effectiveRefs = highlightRefs;
  const effectiveUnion = highlightUnion;
  const effectiveGroups = highlightGroups;

  // The realistic FACE currently shown: 'F' (Front face) / 'B' (Back face), or
  // null for any copper layer. Highlights only appear on the faces - a copper
  // layer isn't "a PCB-mounted component", so no box there.
  const visibleFace =
    sheets[shownIndex]?.slug === 'front'
      ? 'F'
      : sheets[shownIndex]?.slug === 'back'
        ? 'B'
        : null;

  const activeRef = useRef(active);
  activeRef.current = active;
  // Stack depth, read through a ref so the walk below can clamp to it without
  // taking `sheets` as a dependency and rebuilding on every parse.
  const sheetCountRef = useRef(0);
  sheetCountRef.current = sheets.length;

  // The layer the VISITOR chose, as opposed to one a hover borrowed. Every
  // deliberate pick (rail click, deck dot, sheet click, chevron/key/wheel step,
  // mobile swipe) moves this; a hover-driven flip never does. Hovering a
  // bottom-side part therefore borrows the bottom layer and hands it back when
  // the pointer leaves, instead of stranding the visitor on a layer they never
  // asked for. Defaults to 0, the top.
  const anchorRef = useRef(0);

  // Walk the stack one layer at a time instead of cutting straight to the
  // target, so a flip from top to bottom shows what is in between: the visitor
  // sees the board is eight layers deep rather than watching two faces swap.
  // Each step retriggers the sheets' 0.6s transform transition, so the steps
  // overlap into one continuous sweep rather than eight discrete hops.
  //
  // The sweep is eased, not linear, and the curve lives in board-swap-timing.ts
  // (`layerSweepDelays`) so it is unit-testable without a browser: this file can
  // only be exercised through rAF, which a backgrounded tab suspends.
  const travelRef = useRef<number | null>(null);
  const cancelTravel = useCallback(() => {
    if (travelRef.current != null) {
      window.clearTimeout(travelRef.current);
      travelRef.current = null;
    }
  }, []);
  // Cancel on unmount so a pending step can't setState on a dead component.
  useEffect(() => cancelTravel, [cancelTravel]);
  const travelTo = useCallback((target: number) => {
    cancelTravel();
    const from = activeRef.current;
    // Clamp rather than trust the caller: a tier switch to a board with fewer
    // layers can leave the anchor pointing past the end of the new stack, and
    // an unclamped walk would step forever past the last sheet.
    const last = Math.max(0, sheetCountRef.current - 1);
    target = Math.max(0, Math.min(last, target));
    if (target === from) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setActive(target);
      return;
    }
    const dir = target > from ? 1 : -1;
    const delays = layerSweepDelays(Math.abs(target - from));
    let done = 0;
    const schedule = () => {
      travelRef.current = window.setTimeout(() => {
        done += 1;
        // Writing the ref here as well as in render keeps the walk correct even
        // though the next render has not happened yet when the timer re-arms.
        activeRef.current += dir;
        setActive(activeRef.current);
        if (done >= delays.length) {
          travelRef.current = null;
          return;
        }
        schedule();
      }, delays[done]);
    };
    schedule();
  }, [cancelTravel]);

  // Deliberate layer pick: stop any hover-driven walk, and move the anchor so
  // this is the layer a later hover-off returns to.
  const selectLayer = useCallback(
    (i: number) => {
      cancelTravel();
      anchorRef.current = i;
      setActive(i);
    },
    [cancelTravel],
  );
  // Updater form, for callers that compute the next index from the current one
  // (useLayerSwipe). Reads through the ref so it never sees a stale index.
  const selectLayerFrom = useCallback(
    (updater: (i: number) => number) => selectLayer(updater(activeRef.current)),
    [selectLayer],
  );

  // A different board (product or tier switch) starts at the top again, so the
  // anchor must not carry the previous board's chosen layer across.
  useEffect(() => {
    anchorRef.current = 0;
  }, [src]);

  // On a new hover, flip the stack to the FACE that mounts the part (front for
  // F-side parts, back for B-side) so the box always lands on a face, never a
  // copper layer. On hover-off, walk back to the visitor's own layer. Deps
  // exclude `active` (read via ref) so manual layer paging isn't fought; only a
  // hover change triggers a flip.
  useEffect(() => {
    if (!manifest) return;
    if (!highlightRefs?.length) {
      travelTo(anchorRef.current);
      return;
    }
    const comps = highlightRefs
      .map((r) => manifest.map.get(r))
      .filter(Boolean) as BoardComponent[];
    if (!comps.length) return;
    const fCount = comps.filter((c) => c.layer === 'F').length;
    const targetFace = fCount >= comps.length - fCount ? 'front' : 'back';
    const idx = sheets.findIndex((s) => s.slug === targetFace);
    if (idx >= 0 && idx !== activeRef.current) travelTo(idx);
    // travelTo/anchorRef are stable refs+closures over state read through refs;
    // adding them would re-run this on every render and restart the walk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, highlightRefs, sheets]);

  // Footprint boxes for parts mounted on the visible FACE only. A padded bbox
  // rect (mm, in the board viewBox frame) - drawn anchored INSIDE the sheet svg
  // so it scrolls with the board and sits exactly on the part.
  const highlights = useMemo(() => {
    if (!manifest || !effectiveRefs?.length || !visibleFace) return [];
    const PAD = 0.4; // mm breathing room so the box comfortably encloses the part
    const out: Array<{ref: string; rect: number[]}> = [];
    for (const r of effectiveRefs) {
      const c = manifest.map.get(r);
      if (!c || c.layer !== visibleFace || !c.bbox) continue;
      out.push({
        ref: r,
        rect: [
          c.bbox.x - PAD,
          c.bbox.y - PAD,
          c.bbox.w + 2 * PAD,
          c.bbox.h + 2 * PAD,
        ],
      });
    }
    return out;
  }, [manifest, effectiveRefs, visibleFace]);
  // Tell the parent whether the highlight is currently visible (boxes on the
  // shown face) so its tap-toggle can re-assert a part hidden under another layer.
  useEffect(() => {
    onHighlightVisible?.(highlights.length > 0);
  }, [highlights, onHighlightVisible]);
  // Draw the highlight ANCHORED inside the active sheet's own <svg>, so it
  // scrolls with the board and sits exactly on the part (it shares the viewBox +
  // every transform). Per hover we append a <g> with: a subtle dim veil over the
  // face (clipped to the board outline, with a feathered hole at each part) and a
  // gold box outline per part on top. Only runs on a FACE (highlights is empty
  // on copper layers), so there's never a box on an inner layer. No screen-space
  // overlay, no scroll tracking - fully anchored + deterministic.
  useEffect(() => {
    // Inject highlights into the LIVE stack only - never the outgoing one.
    const stack = bodyRef.current?.querySelector('[data-role="live"]');
    if (!stack) return;
    const NS = 'http://www.w3.org/2000/svg';
    const cache = spotCache.current;

    // Prune cached spotlights whose face left the DOM (tier / board swap).
    for (const [el, entry] of cache) {
      if (!el.isConnected) {
        entry.g.remove();
        cache.delete(el);
      }
    }

    const svg = stack.querySelector('.board-sheet.is-active svg');

    // No highlight (or no face yet) → hide every cached spotlight (keep it built
    // so re-entering the list is instant + flash-free), and arm the next entry
    // to fade in fresh.
    if (!highlights.length || !svg) {
      for (const entry of cache.values()) {
        entry.g.setAttribute('class', 'board-hilite is-hidden');
      }
      hadHilite.current = false;
      return;
    }

    // Box layout: per-refdes by default; ONE union box for dense arrays
    // (`highlightUnion`, e.g. the bulk-cap grid); or one union box per subgroup
    // (`highlightGroups`, e.g. ESC motor pads grouped by motor → 4 boxes).
    const unionRect = (rs: Array<{rect: number[]}>) => {
      const x0 = Math.min(...rs.map((h) => h.rect[0]));
      const y0 = Math.min(...rs.map((h) => h.rect[1]));
      const x1 = Math.max(...rs.map((h) => h.rect[0] + h.rect[2]));
      const y1 = Math.max(...rs.map((h) => h.rect[1] + h.rect[3]));
      return [x0, y0, x1 - x0, y1 - y0];
    };
    let boxes: Array<{ref: string; rect: number[]}>;
    if (effectiveGroups?.length) {
      boxes = effectiveGroups
        .map((group) => {
          const set = new Set(group);
          const rs = highlights.filter((h) => set.has(h.ref));
          return rs.length ? {ref: 'group', rect: unionRect(rs)} : null;
        })
        .filter((b): b is {ref: string; rect: number[]} => b !== null);
    } else if (effectiveUnion && highlights.length > 1) {
      boxes = [{ref: 'union', rect: unionRect(highlights)}];
    } else {
      boxes = highlights;
    }

    // Fill the per-box geometry into a live group: the lit window(s) - one union
    // clipPath (a <rect> per box) shared by a SINGLE bright face image - plus the
    // gold boxes. Leaves the dim veil + cloned face image alone, so a move only
    // slides the lit window; the dim never re-rasterises, the image never
    // re-decodes (that was the flash).
    const paintWindows = (brightClip: Element, group: Element) => {
      while (brightClip.firstChild)
        brightClip.removeChild(brightClip.firstChild);
      for (const h of boxes) {
        const cr = document.createElementNS(NS, 'rect');
        cr.setAttribute('x', String(h.rect[0]));
        cr.setAttribute('y', String(h.rect[1]));
        cr.setAttribute('width', String(h.rect[2]));
        cr.setAttribute('height', String(h.rect[3]));
        cr.setAttribute('rx', '0.5');
        brightClip.appendChild(cr);
      }
      group
        .querySelectorAll('.board-highlight-shape')
        .forEach((n) => n.remove());
      for (const h of boxes) {
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', String(h.rect[0]));
        rect.setAttribute('y', String(h.rect[1]));
        rect.setAttribute('width', String(h.rect[2]));
        rect.setAttribute('height', String(h.rect[3]));
        rect.setAttribute('rx', '0.4');
        rect.setAttribute('class', 'board-highlight-shape');
        group.appendChild(rect);
      }
    };

    // Hide spotlights cached for OTHER faces (only the active face shows one).
    for (const [el, entry] of cache) {
      if (el !== svg) entry.g.setAttribute('class', 'board-hilite is-hidden');
    }

    // Fade in only when entering the list from nothing; a row move or face flip
    // mid-hover shows instantly (no fade, no flash).
    const cls = hadHilite.current ? 'board-hilite' : 'board-hilite is-fresh';

    // REUSE this face's cached spotlight: un-hide + just slide the lit window.
    const hit = cache.get(svg);
    if (hit && hit.g.isConnected && hit.brightClip) {
      hit.g.setAttribute('class', cls);
      paintWindows(hit.brightClip, hit.g);
      hadHilite.current = true;
      return;
    }

    // FRESH BUILD for this face (first time it's lit). The dim veil + ONE bright
    // face clone + union clip are built ONCE here and cached; later hovers on
    // this face take the reuse path above.
    svg.querySelectorAll('g.board-hilite').forEach((g) => g.remove());
    cache.delete(svg);
    const vb = manifest?.viewBox?.split(/\s+/).map(Number);
    const outlineClip = svg.querySelector(
      'clipPath',
    ) as SVGClipPathElement | null;
    const clipId = outlineClip?.id;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', cls);

    // SPOTLIGHT: DIM the board everywhere EXCEPT the lit window(s). The dim
    // region is the board bbox + a margin (NOT a giant rect - a huge masked
    // element overflows the browser's mask buffer and only renders a corner).
    if (vb && vb.length === 4 && vb.every((n) => Number.isFinite(n))) {
      const M = Math.max(vb[2], vb[3]); // generous region (covers any overhang)
      const rx0 = vb[0] - M;
      const ry0 = vb[1] - M;
      const rw = vb[2] + 2 * M;
      const rh = vb[3] + 2 * M;
      const defs = document.createElementNS(NS, 'defs');
      const faceImg = svg.querySelector('image');
      if (faceImg) {
        // Dim the WHOLE board picture - including ports that overhang the
        // Edge.Cuts outline - by masking a dark layer with the FACE IMAGE's
        // ALPHA (covers exactly the rendered board + ports, soft edges, no page
        // bleed). Then re-show ONE bright face clipped to a single union clipPath
        // (one <rect> per box) on top - so a row move only edits those rects, not
        // the image clones. No outline clip → no bright port sliver.
        const dimMask = document.createElementNS(NS, 'mask');
        dimMask.setAttribute('id', `od-dim-${uid}`);
        dimMask.setAttribute('maskUnits', 'userSpaceOnUse');
        dimMask.setAttribute('mask-type', 'alpha');
        dimMask.setAttribute('x', String(rx0));
        dimMask.setAttribute('y', String(ry0));
        dimMask.setAttribute('width', String(rw));
        dimMask.setAttribute('height', String(rh));
        dimMask.appendChild(faceImg.cloneNode(true));
        defs.appendChild(dimMask);
        const brightClip = document.createElementNS(NS, 'clipPath');
        brightClip.setAttribute('id', `od-bright-${uid}`);
        brightClip.setAttribute('clipPathUnits', 'userSpaceOnUse');
        defs.appendChild(brightClip);
        g.appendChild(defs);
        const dim = document.createElementNS(NS, 'rect');
        dim.setAttribute('x', String(rx0));
        dim.setAttribute('y', String(ry0));
        dim.setAttribute('width', String(rw));
        dim.setAttribute('height', String(rh));
        dim.setAttribute('class', 'board-hilite-dim');
        dim.setAttribute('mask', `url(#od-dim-${uid})`);
        g.appendChild(dim);
        const bface = faceImg.cloneNode(true) as SVGElement;
        bface.removeAttribute('id');
        bface.setAttribute('clip-path', `url(#od-bright-${uid})`);
        bface.setAttribute('class', 'board-hilite-face');
        g.appendChild(bface);
        // Lit window(s) + gold boxes - the only parts that move between rows.
        paintWindows(brightClip, g);
        svg.appendChild(g);
        cache.set(svg, {g, brightClip});
        hadHilite.current = true;
        return;
      } else if (clipId) {
        // Fallback (no face image): dim a board-bbox rect with holes per box,
        // clipped to the outline. No <image> here, so rebuilding can't flash.
        const mask = document.createElementNS(NS, 'mask');
        mask.setAttribute('id', `od-spot-${uid}`);
        mask.setAttribute('maskUnits', 'userSpaceOnUse');
        mask.setAttribute('x', String(rx0));
        mask.setAttribute('y', String(ry0));
        mask.setAttribute('width', String(rw));
        mask.setAttribute('height', String(rh));
        const base = document.createElementNS(NS, 'rect');
        base.setAttribute('x', String(rx0));
        base.setAttribute('y', String(ry0));
        base.setAttribute('width', String(rw));
        base.setAttribute('height', String(rh));
        base.setAttribute('fill', '#fff');
        mask.appendChild(base);
        for (const h of boxes) {
          const hole = document.createElementNS(NS, 'rect');
          hole.setAttribute('x', String(h.rect[0]));
          hole.setAttribute('y', String(h.rect[1]));
          hole.setAttribute('width', String(h.rect[2]));
          hole.setAttribute('height', String(h.rect[3]));
          hole.setAttribute('rx', '0.5');
          hole.setAttribute('fill', '#000');
          mask.appendChild(hole);
        }
        defs.appendChild(mask);
        g.appendChild(defs);
        const dim = document.createElementNS(NS, 'rect');
        dim.setAttribute('x', String(rx0));
        dim.setAttribute('y', String(ry0));
        dim.setAttribute('width', String(rw));
        dim.setAttribute('height', String(rh));
        dim.setAttribute('class', 'board-hilite-dim');
        dim.setAttribute('mask', `url(#od-spot-${uid})`);
        dim.setAttribute('clip-path', `url(#${clipId})`);
        g.appendChild(dim);
      }
    }

    // Gold box per part, on top (fallback / no-viewBox path - no reusable clip).
    for (const h of boxes) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', String(h.rect[0]));
      rect.setAttribute('y', String(h.rect[1]));
      rect.setAttribute('width', String(h.rect[2]));
      rect.setAttribute('height', String(h.rect[3]));
      rect.setAttribute('rx', '0.4');
      rect.setAttribute('class', 'board-highlight-shape');
      g.appendChild(rect);
    }
    svg.appendChild(g);
    cache.set(svg, {g, brightClip: null});
    hadHilite.current = true;
  }, [
    shownIndex,
    revealed,
    sheets,
    highlights,
    manifest,
    effectiveUnion,
    effectiveGroups,
    visibleFace,
    uid,
  ]);

  // Memoise the sheet stack so a hover never re-renders these <button>s. A hover
  // changes highlight props on the PARENT, re-rendering BoardArt; React was then
  // re-applying each dangerouslySetInnerHTML and rebuilding the board <svg> on
  // every hover - re-decoding the board image and flashing the spotlight. Keyed
  // on [sheets, active] only, the element array is referentially stable across
  // hovers, so React skips this subtree entirely: the svg nodes stay put and the
  // imperatively-injected highlight overlay is reused (above) instead of rebuilt.
  const stackSheets = useMemo(
    () =>
      sheets.map((s, i) => (
        // One layer on screen at a time. Mobile: the incoming layer slides up +
        // fades in over the outgoing (CSS) - a clean peel, no per-layer boxes.
        <button
          type="button"
          key={s.slug}
          className={`board-sheet${i === shownIndex ? ' is-active' : ''}${
            i < shownIndex ? ' is-before' : ''
          }`}
          // --rel = position relative to the active layer (0 = on screen, ±n =
          // n cards off either edge); the mobile peel slides each sheet to
          // (--rel + --drag) * 100%. Desktop ignores it (uses the --depth fan).
          style={{
            ['--depth' as string]: i,
            ['--rel' as string]: i - shownIndex,
          }}
          aria-label={`Show ${s.label} layer`}
          aria-pressed={i === shownIndex}
          onClick={() => selectLayer(i)}
          dangerouslySetInnerHTML={{__html: s.html}}
        />
      )),
    [sheets, shownIndex, isMobile, selectLayer],
  );

  const stackElRef = useRef<HTMLDivElement | null>(null);
  // ── Variant swap FSM (see swapReducer above) ─────────────────────────────────
  // On a tier toggle the component stays mounted and `src` changes; the live stack
  // re-renders to the NEW board (the sheets memo) while a FROZEN snapshot of the
  // OLD board is mounted as a real React subtree (.board-swap-out) that flies out.
  // No innerHTML clone, no captured ref, no wall-clock timer - the swap ENDS by
  // counting board-swap-out animationend events. This replaces the whole ghost
  // machine that was the source of the "behind / restarts / hangs / laggy" bugs.
  const [swap, dispatchSwap] = useReducer(swapReducer, undefined, () => ({
    phase: 'idle' as const,
    gen: 0,
    committedSrc: src,
    outgoing: null,
    expected: 0,
    outCount: 0,
    remaining: 0,
  }));
  // Keep parent callbacks in refs so the lifecycle effect can depend ONLY on
  // (phase, gen) - an inline callback's changing identity must not re-fire
  // onSwapStart or re-arm the backstop mid-run.
  const onSwapStartRef = useRef(onSwapStart);
  onSwapStartRef.current = onSwapStart;
  const onSwapSettleRef = useRef(onSwapSettle);
  onSwapSettleRef.current = onSwapSettle;

  // Driver: turn an (src ≠ committedSrc) delta into the right action. Layout effect
  // so the decision lands on the same commit that flipped `sheets` to the new board.
  useIsoLayoutEffect(() => {
    if (src === swap.committedSrc) return;
    const wide =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(min-width: 1024px)').matches;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // The board to fly OUT is the one committedSrc was showing - read it from the
    // parse cache (always warmed for an on-screen tier), frozen at the index the
    // visitor was on. NEVER read live `sheets`/`active` (already the NEW board).
    const outSheets =
      parsedCache.get(swap.committedSrc) ?? lastSheetsRef.current;
    // Off-screen swap: the user changed the SKU while looking elsewhere on the
    // page (the board isn't in view), so animating the layer fly-out/in is wasted
    // work and reads as lag. Hard-cut to the new board AND re-arm the entrance, so
    // it plays the full reveal fresh when they scroll back to the teardown.
    if (flyDone && !reduce && !visibleRef.current) {
      const g = swap.gen + 1;
      dispatchSwap({type: 'HARDCUT', src});
      onSwapStartRef.current?.(g);
      onSwapSettleRef.current?.(g);
      setFlyDone(false);
      setFlyIn(false);
      setRailIn(false);
      return;
    }
    // No entrance yet / reduced-motion / nothing to peel → hard-cut (no animation),
    // but still signal the parent (start+settle) so its list swaps cleanly.
    if (!flyDone || reduce || !outSheets || !outSheets.length) {
      const g = swap.gen + 1;
      dispatchSwap({type: 'HARDCUT', src});
      onSwapStartRef.current?.(g);
      onSwapSettleRef.current?.(g);
      return;
    }
    if (swap.phase === 'run') {
      // Already mid-flight: the live stack follows the newest src on its own; just
      // record the target and let the running fly-out finish (no 2nd outgoing).
      dispatchSwap({type: 'RETARGET', src});
      return;
    }
    dispatchSwap({
      type: 'START',
      src,
      outgoing: {
        sheets: outSheets,
        shownIndex: Math.min(activeRef.current, outSheets.length - 1),
      },
      // Settle counts the INCOMING (new board) layers - it lands last. Delay is
      // driven by the OUTGOING count. Mobile is a single whole-board slide → 1.
      expected: wide ? sheets.length : 1,
      outCount: wide ? outSheets.length : 1,
    });
  }, [src, sheets, flyDone, swap.committedSrc, swap.phase, swap.gen]);

  // Lifecycle + settle backstop, keyed on (phase, gen) ONLY. Fires the parent
  // start/settle once per run, gates rail placement (swapActiveRef), re-places the
  // rail on settle, and arms a backstop that force-settles a dropped animationend.
  useEffect(() => {
    if (swap.phase === 'run') {
      swapActiveRef.current = true;
      onSwapStartRef.current?.(swap.gen);
      const gen = swap.gen;
      const t = setTimeout(
        () => dispatchSwap({type: 'SETTLE', gen}),
        swapSettleBackstopMs(swap.outCount || 1, swap.expected || 1),
      );
      return () => clearTimeout(t);
    }
    if (swapActiveRef.current) {
      swapActiveRef.current = false;
      onSwapSettleRef.current?.(swap.gen);
      // Re-place the rail now the board has settled (it was held during the swap so
      // the layer textbox didn't jump against the mid-animation board).
      setPlaceNonce((n) => n + 1);
    }
  }, [swap.phase, swap.gen, swap.expected, swap.outCount]);

  // The swap settles when the INCOMING board has fully landed (the IN phase runs
  // AFTER the OUT phase, so it finishes last). Count board-swap-in animationend on
  // the LIVE stack for THIS generation; superseded generations' stragglers are
  // dropped by the reducer's gen check, and a dropped event is caught by the
  // backstop. board-swap-out (outgoing) and the board-sheet-fly entrance are
  // filtered out by name.
  const onLiveAnimEnd = (e: ReactAnimationEvent) => {
    if (e.animationName !== 'board-swap-in') return;
    dispatchSwap({type: 'EVENT', gen: swap.gen});
  };

  // The layer rail (the "Layer X/8" + tab list) crossfades when the layer SET
  // actually changes between boards, so it doesn't hard-snap during a swap. Guarded
  // by a label signature: variants that share the same layers (e.g. both 8-layer
  // boards) never animate, so identical content never pulses. `railSheets` lags the
  // live sheets so the OLD tabs fade out, the set switches while hidden, the NEW
  // fade in - the same crossfade the component table uses.
  const railSig = useMemo(() => sheets.map((s) => s.label).join('|'), [sheets]);
  const [railSheets, setRailSheets] = useState<Sheet[]>(sheets);
  const [railSwapping, setRailSwapping] = useState(false);
  const prevRailSigRef = useRef(railSig);
  useEffect(() => {
    if (prevRailSigRef.current === railSig) {
      setRailSheets(sheets);
      return;
    }
    prevRailSigRef.current = railSig;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setRailSheets(sheets);
      return;
    }
    setRailSwapping(true);
    const t1 = setTimeout(() => setRailSheets(sheets), 235);
    const t2 = setTimeout(() => setRailSwapping(false), 520);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [railSig, sheets]);
  const railCount = railSheets.length;
  const railIndex = Math.min(shownIndex, Math.max(0, railCount - 1));

  // Step through the stack, clamped to its ends (used by chevrons / keys / wheel).
  const step = (delta: number) =>
    selectLayer(Math.min(sheets.length - 1, Math.max(0, activeRef.current + delta)));

  // Mobile: drag the board ←/→ to peel a layer. The active sheet really slides
  // out under the finger while the next/prev sheet chases in behind it (the
  // peel is driven by --drag in CSS); a flick or a far-enough drag commits,
  // else it snaps back. Vertical is left to the page (touch-action: pan-y), so
  // a swipe that reads as vertical just scrolls - only horizontal is captured.
  const {drag, dragging} = useLayerSwipe({
    ref: stackElRef,
    count: sheets.length,
    index: shownIndex,
    setIndex: selectLayerFrom,
    enabled: isMobile,
  });

  return (
    <div
      ref={ref}
      className={`board-art board-folder${revealed ? ' is-revealed' : ''}${
        revealed && !flyDone ? ' is-armed' : ''
      }${warm && !flyDone ? ' is-warm' : ''}${
        flyIn && !flyDone ? ' is-flying' : ''
      }${flyDone ? ' is-swap-ready' : ''}${railIn ? ' is-rail-in' : ''}`}
      // The swap durations live in ONE place (SWAP_TIMING) and are pushed to CSS
      // here so the @keyframes block and the JS settle backstop read identical
      // numbers - change a duration in board-swap-timing.ts and both follow.
      style={
        {
          ['--swap-dur' as string]: `${SWAP_TIMING.durS}s`,
          ['--swap-stagger' as string]: `${SWAP_TIMING.staggerS}s`,
          ['--swap-exit' as string]: `${SWAP_TIMING.exitS}s`,
          // The IN phase waits for the OUT phase to finish (old fully leaves before
          // the new arrives - no overlap). Computed live from the outgoing count.
          ['--swap-in-delay' as string]:
            swap.phase === 'run'
              ? `${swapInDelayS(swap.outCount || 1)}s`
              : '0s',
        } as CSSProperties
      }
      data-board={handle}
    >
      {sheets.length ? (
        <div className="board-folder-body" ref={bodyRef}>
          {/* Roving keyboard-nav group: arrow keys step the layer stack. The
              interactive controls (buttons) live inside; the group itself is
              focusable to capture arrow nav. Wheel is intentionally NOT captured
              - scrolling over the panel scrolls the page like anywhere else. */}
          {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          <div
            className={`board-folder-rail${railSwapping ? ' is-swapping' : ''}`}
            ref={railRef}
            role="group"
            aria-label="Copper layer"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                step(1);
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                step(-1);
              }
            }}
          >
            <span className="board-folder-rail-head">
              Layer
              <span className="board-folder-rail-count">
                {railIndex + 1}/{railCount}
              </span>
            </span>
            <div className="board-folder-tabs">
              {railSheets.map((s, i) => (
                <button
                  type="button"
                  key={s.slug}
                  data-slug={s.slug}
                  className={i === railIndex ? 'is-active' : undefined}
                  aria-pressed={i === railIndex}
                  onClick={() => selectLayer(i)}
                >
                  <span className="board-folder-tab-name">{s.label}</span>
                  <span className="board-folder-tab-fn">
                    {layerFunction(s.slug, i, railCount, layerFns)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          <div className="board-stack-wrap">
            {/* The LIVE (incoming/new) stack. data-role="live" scopes the rail
                placement, highlight injection and swipe to THIS stack so they can
                never resolve to the outgoing one during a swap. */}
            <div
              ref={stackElRef}
              data-role="live"
              className={`board-folder-stack${
                swap.phase === 'run' ? ' is-swapping' : ''
              }${dragging ? ' is-dragging' : ''}`}
              style={{['--drag' as string]: drag}}
              onAnimationEnd={onLiveAnimEnd}
            >
              {stackSheets}
              {/* Component highlights are injected into the active sheet's own
                  <svg> by the effect above (so they inherit its viewBox + every
                  transform); there is no separate overlay element here. */}
            </div>
            {/* The OUTGOING (old) stack - a real React subtree built from a FROZEN
                snapshot (its own sheets + the index that was showing), flying out
                beneath the live one. Counting its board-swap-out animationend
                events is what settles the swap. */}
            {swap.outgoing ? (
              <div
                key={swap.gen}
                data-role="out"
                className="board-folder-stack board-swap-out"
                aria-hidden="true"
              >
                {swap.outgoing.sheets.map((s, i) => (
                  <button
                    type="button"
                    key={s.slug}
                    tabIndex={-1}
                    className={`board-sheet${
                      i === swap.outgoing!.shownIndex ? ' is-active' : ''
                    }${i < swap.outgoing!.shownIndex ? ' is-before' : ''}`}
                    style={{
                      ['--depth' as string]: i,
                      ['--rel' as string]: i - swap.outgoing!.shownIndex,
                    }}
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{__html: s.html}}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {isMobile && sheets.length ? (
            <div className="board-deck-progress">
              {/* Lightweight progress: a tick per layer (how far through the
                  stack you are) - and each is tappable to jump straight there. */}
              <div className="board-deck-dots" aria-label="Board layer">
                {sheets.map((s, i) => (
                  <button
                    type="button"
                    key={s.slug}
                    className={`board-deck-dot${i === shownIndex ? ' is-active' : ''}${
                      i < shownIndex ? ' is-done' : ''
                    }`}
                    aria-label={`Show ${s.label} layer`}
                    aria-current={i === shownIndex ? 'true' : undefined}
                    onClick={() => selectLayer(i)}
                  />
                ))}
              </div>
              <p className="board-deck-meta" aria-live="polite">
                <span className="board-deck-count">
                  {shownIndex + 1}/{sheets.length}
                </span>
                <span className="board-deck-name">
                  {sheets[shownIndex]?.label}
                </span>
                <span className="board-deck-hint">Swipe ←/→</span>
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {!revealed && !failed ? (
        <div className="board-art-skeleton" aria-hidden="true">
          {/* Dimmed static face render as backdrop - the asset the canvas is
              about to draw anyway - so a slow init reads as "developing"
              instead of a viewport of black. */}
          <img
            className="board-art-skeleton-preview"
            // The dimmed 800 px thumbnail (export-board-art.mjs derivative),
            // not the 1568 px PNG: it is a blurred backdrop, and the full face
            // fetched here on top of the stack's own face was 394 KB twice.
            src={assetUrl(versioned(src.replace(/board\.svg$/, 'front-w800.webp')))}
            alt=""
            loading="lazy"
            decoding="async"
          />
          <span className="board-art-skeleton-spinner" />
          <span className="board-art-skeleton-label">Loading the layer view…</span>
        </div>
      ) : null}
      {failed ? (
        <p className="board-art-fallback">
          Board art unavailable.{' '}
          {inspectUrl ? (
            <a href={inspectUrl} target="_blank" rel="noopener noreferrer">
              Open on KiCanvas ↗
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
