import {Await, PrefetchPageLinks, useLoaderData, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {CAMPAIGN} from '~/lib/catalog-client';
import {PreorderStrip} from '~/components/PreorderStrip';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {AnimatePresence, motion, useReducedMotion} from 'motion/react';
import {Link} from '~/components/nav';
import type {Route} from './+types/_index';
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  Suspense,
} from 'react';
import type {MoneyV2, ProductCardFragment} from '~/lib/product-shapes';
import {byHandle, formatPrice, toCard} from '~/lib/catalog';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {useProductStatusResolver, useRoadmapStatusResolver} from '~/lib/coming-soon';
import {
  isComingSoon,
  isConceptFor,
  isPurchasableStatus,
} from '~/lib/product-content';
import {HeroDroneStage} from '~/components/HeroDroneStage';
import type {HeroLoadState} from '~/components/HeroDroneScene';
import {HeroWordmark} from '~/components/HeroWordmark';
import {HeroSizeSlider} from '~/components/HeroSizeSlider';
import {
  HERO_AIRFRAMES,
  HERO_AIRFRAME_KEYS,
  HERO_BOARDS,
  HERO_VARIANT_AXIS,
  type HeroBoardKey,
} from '~/lib/hero-airframes';
import {MobileHome} from '~/components/MobileHome';
import {SceneErrorBoundary} from '~/components/SceneErrorBoundary';
import {HERO_REVEAL_WINDOWS, HERO_SLOTS} from '~/lib/builder/registry';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * The homepage's words live in `content/copy/home.json`, shared with
 * `MobileHome` (its keys are prefixed `m_`; the Shop label is one key used by
 * both layouts so it is edited once). Everything else here is machinery -
 * scroll progress, reveal windows, splash phases, the `--hero-p` custom
 * property - and none of it is copy. Product titles, prices and the load
 * manifest's piece labels are runtime data, not editable strings.
 */
export const meta: Route.MetaFunction = ({location}) =>
  buildSeoMeta({
    // buildSeoMeta appends "| OpenDrone"; don't repeat the brand here.
    title: copyText('home.meta_title') ?? 'Open Source Drone Parts',
    description: copyText('home.meta_description') ?? '',
    url: `${SITE_ORIGIN}${location.pathname}`,
  });

type HomeMoney = Pick<MoneyV2, 'amount' | 'currencyCode'>;
type HomeProduct = ProductCardFragment;
type HomeFeaturedResult = {
  frame: HomeProduct | null;
  rx: HomeProduct | null;
  fc: HomeProduct | null;
  esc: HomeProduct | null;
  motor: HomeProduct | null;
};

// A ready-to-render hero reveal card - resolved server-side so the view stays
// data-driven (the client just maps over the active size's stack).
export type HeroCard = {
  boardKey: HeroBoardKey;
  handle: string;
  /** PDP link, including `?Model=…` for size-variant boards. */
  url: string;
  title: string;
  productType: string | null;
  image: {url: string; altText: string | null} | null;
  price: HomeMoney | null;
};
/** Keyed by airframe size key (see HERO_AIRFRAMES). */
export type HeroStacks = Record<string, HeroCard[]>;

/**
 * Airframe sizes whose 3D assembly is built (`public/models/od<size>/`).
 * The hero only offers these: a size without an assembly would show the
 * 3 inch drone under a 5 inch label and price. Add '5' here once
 * `public/models/od5/` exists; the size toggle appears when two are built.
 */
const HERO_BUILT_SIZES: readonly string[] = ['3'];

/**
 * Shop names for the pieces the splash manifest ticks off. `chunks.json` is
 * written by the hero build from the CAD part names ("OpenFC", "4in1-mini");
 * a buyer reads the names the shop sells, so a known chunk id is shown under
 * its product name and an unknown one keeps its build label.
 */
const HERO_PIECE_NAMES: Readonly<Record<string, string>> = {
  frame: 'OpenFrame 3" Freestyle',
  'board-4in1-mini': 'OpenESC 20×20',
  'board-OpenFC': 'OpenFC Lite 20×20',
  'board-OpenRX-Lite-UFL': 'OpenRX Lite-UFL',
};
const HERO_SIZES = HERO_AIRFRAME_KEYS.filter((k) => HERO_BUILT_SIZES.includes(k));
const HERO_START_SIZE = HERO_SIZES[0] ?? HERO_AIRFRAME_KEYS[0];

/** A variant whose option value names this airframe size, e.g. `3" Freestyle`
 *  for size "3": how the frame, one product with a size option, matches. */
function variantForSize(p: HomeProduct, size: string) {
  const re = new RegExp(`^${size}\\s*(?:"|″|in\\b|inch)`, 'i');
  return (
    p.variants.nodes.find((v) => v.selectedOptions.some((o) => re.test(o.value.trim()))) ?? null
  );
}

function emptyHeroStacks(): HeroStacks {
  const stacks: HeroStacks = {};
  for (const af of HERO_AIRFRAMES) stacks[af.key] = [];
  return stacks;
}

// Resolve each airframe size's [FC, ESC, Frame] cards from the queried
// products. Size-variant boards (FC/ESC) match the size's `model` against the
// product's "Model" option values, linking to that variant and using its
// price; a size with no matching variant falls back to the base product link
// + min price so the card still renders. Fully driven by the HERO_AIRFRAMES /
// HERO_BOARDS registry - adding a size needs no change here.
function buildHeroStacks(d: HomeFeaturedResult): HeroStacks {
  const byBoard: Record<HeroBoardKey, HomeProduct | null> = {
    fc: d.fc,
    esc: d.esc,
    frame: (d.frame as HomeProduct | null) ?? null,
  };
  const stacks: HeroStacks = {};
  for (const af of HERO_AIRFRAMES) {
    const cards: HeroCard[] = [];
    for (const board of HERO_BOARDS) {
      const p = byBoard[board.boardKey];
      if (!p) continue;
      let url = `/products/${board.handle}`;
      let price: HomeMoney | null = p.priceRange.minVariantPrice ?? null;
      // Default to the product's featured image; a matched size variant
      // overrides it below (the featured image is the mini/first variant).
      let image = p.featuredImage
        ? {url: p.featuredImage.url, altText: p.featuredImage.altText ?? null}
        : null;
      const model = board.sizeVariant ? af.model : undefined;
      // The frame is one product with a size option: link and price the
      // variant for this airframe, not the cheapest one.
      const sized = board.sizeVariant ? null : variantForSize(p, af.key);
      if (sized) {
        const q = new URLSearchParams(sized.selectedOptions.map((o) => [o.name, o.value]));
        url += `?${q.toString()}`;
        if (sized.price) price = sized.price;
        if (sized.image)
          image = {url: sized.image.url, altText: sized.image.altText ?? null};
      }
      if (model) {
        const axis = HERO_VARIANT_AXIS.toLowerCase();
        const want = model.trim().toLowerCase();
        const variant = p.variants.nodes.find((v) =>
          v.selectedOptions.some(
            (o) =>
              o.name.trim().toLowerCase() === axis &&
              o.value.trim().toLowerCase() === want,
          ),
        );
        if (variant) {
          // Link with the value the LIVE variant carries (preserves exact
          // casing/encoding) so the PDP resolves it cleanly.
          const liveValue =
            variant.selectedOptions.find(
              (o) => o.name.trim().toLowerCase() === axis,
            )?.value ?? model;
          url += `?${HERO_VARIANT_AXIS}=${encodeURIComponent(liveValue)}`;
          if (variant.price) price = variant.price;
          if (variant.image)
            image = {
              url: variant.image.url,
              altText: variant.image.altText ?? null,
            };
        }
      }
      cards.push({
        boardKey: board.boardKey,
        handle: board.handle,
        url,
        // Size-variant boards spell out which mount they are (e.g. "OpenESC
        // 30×30") so the two airframes' cards aren't indistinguishable; the
        // shared frame keeps its plain title.
        title:
          board.sizeVariant && !p.title.includes(af.model)
            ? `${p.title} ${af.model}`
            : sized && !p.title.includes(sized.title)
              ? `${p.title} ${sized.title}`
              : p.title,
        productType: p.productType ?? null,
        image,
        price,
      });
    }
    stacks[af.key] = cards;
  }
  return stacks;
}

export async function loader({request, context}: Route.LoaderArgs) {
  // UA hint picks the SSR layout so a phone gets the static MobileHome on
  // first paint instead of rendering the desktop 3D tree (and its
  // scroll-lock) for a frame before matchMedia corrects it client-side.
  const ua = request.headers.get('user-agent') || '';
  const isMobileHint =
    /Mobi|Android|iPhone|iPod|Windows Phone|BlackBerry/i.test(ua);

  // Flagship line for the mobile showcase. Deferred, not awaited: desktop
  // never renders these cards, and on mobile they sit below the hero - so
  // streaming them keeps TTFB off the catalog fetch entirely (it is worker
  // -cached anyway). Catch resolves to [] so a catalog hiccup just drops
  // the cards instead of blanking the page.
  const home: Promise<{
    featured: HomeProduct[];
    heroStacks: HeroStacks;
  }> = context.catalog
    .get()
    .then((catalog) => {
      const card = (handle: string): HomeProduct | null => {
        const entry = byHandle(catalog, handle);
        return entry ? toCard(catalog, entry) : null;
      };
      const d: HomeFeaturedResult = {
        frame: card('openframe'),
        rx: card('openrx'),
        fc: card('openfc-lite'),
        esc: card('openesc'),
        motor: card('openmotor'),
      };
      const keep = (p: HomeProduct | null): p is HomeProduct => Boolean(p);
      return {
        // Mobile flagship line: the four core parts (FC, ESC, RX, frame). The
        // OpenStack is intentionally NOT here - it's just the FC + ESC bundled,
        // surfaced as a note on the showcase, not as a separate flagship slot.
        featured: [d.fc, d.esc, d.rx, d.frame, d.motor].filter(keep),
        // The three hero boards, resolved per airframe size. FC + ESC are
        // single products with a size variant axis ("Model"): each size links
        // them to its own variant (?Model=…) and shows that variant's price.
        // The frame is one shared SKU. Built off the HERO_AIRFRAMES registry,
        // so a new size is a config edit - see app/lib/hero-airframes.ts.
        heroStacks: buildHeroStacks(d),
      };
    })
    .catch(() => ({featured: [], heroStacks: emptyHeroStacks()}));

  const heroStacks = home.then((h) => h.heroStacks);
  // On a phone the featured cards are the first thing under the hero and the
  // section's arrival used to shift everything below it (CLS 0.22) and delay
  // the LCP image until the deferred chunk streamed in. The query is
  // CacheLong, so awaiting it costs a few ms of TTFB at the edge and puts the
  // cards, and the first card's image, in the initial HTML. Desktop keeps the
  // deferred promise: it never renders these cards.
  const featured = isMobileHint
    ? await home.then((h) => h.featured)
    : home.then((h) => h.featured);

  // The one fixed ship date of the campaign: the stack's paid batch.
  const stackShips =
    Object.values(CAMPAIGN.skus)
      .flatMap((entry) => entry.batches)
      .find((batch) => batch.paid && batch.ships?.trim())
      ?.ships?.trim() ?? null;

  return {isMobileHint, featured, heroStacks, stackShips};
}

// Hero scroll budget - the 3D scene + phased UI stays pinned for this many
// screen heights. Pinned budget (spacer − 100, for the h-screen child) is a
// touch larger than HERO_PROGRESS_VH so progress comfortably reaches 1 and
// the finished state holds for a brief beat before the sticky releases.
// 205 (not the old 220): progress finishes at 100vh and the CTA rise ends at
// p=0.96, so a 5vh settle beat is enough - the extra 15vh was pinned scroll
// where nothing on screen changed, reading as a stuck page.
const HERO_SPACER_VH_DESKTOP = 205;
const HERO_SPACER_VH_MOBILE = 205;
// Scroll denominator for 0..1 progress - how many viewport heights of
// scroll drive the phased animation from start to finish. One viewport
// height means the whole sequence plays out in a single continuous scroll
// gesture, instead of needing several wheel/trackpad flicks to get through.
const HERO_PROGRESS_VH_DESKTOP = 1;
const HERO_PROGRESS_VH_MOBILE = 1;

// Buy-card stack swap on a size change - a horizontal cross-slide timed to MATCH
// the 3D airframe's cross-slide so the cards and the drone move as one gesture.
// Mirrors HeroScene's swap: same duration (TRANS_DUR), same easeInOutCubic, same
// direction, and the same mid-swap zoom dip (both stacks pull back toward the
// middle of the travel). `custom` is the direction (+1 = the new size sits later
// in the registry, so its cards fly in from the right and the old stack flies
// out left; −1 = reverse). The exiting stack is taken out of flow (absolute,
// bottom-anchored to match .hero-buy-stack's column-reverse) so it doesn't shove
// the Shop button while both stacks overlap mid-swap.
const HERO_SWAP_DUR = 0.85; // seconds - must track HeroScene TRANS_DUR
const HERO_SWAP_EASE = [0.65, 0, 0.35, 1] as const; // easeInOutCubic ≈ HeroScene easeSwap
const HERO_SWAP_DIST = 110; // px of horizontal travel
const HERO_SWAP_DIP = 0.9; // mid-swap scale (the zoom-out dip), ~ HeroScene's 0.18 sine dip
const HERO_STACK_SWAP = {
  enter: (dir: number) => ({
    x: dir * HERO_SWAP_DIST,
    opacity: 0,
    scale: HERO_SWAP_DIP,
  }),
  center: {
    x: 0,
    opacity: 1,
    scale: 1,
    transition: {duration: HERO_SWAP_DUR, ease: HERO_SWAP_EASE},
  },
  exit: (dir: number) => ({
    x: -dir * HERO_SWAP_DIST,
    opacity: 0,
    scale: HERO_SWAP_DIP,
    position: 'absolute' as const,
    left: 0,
    right: 0,
    bottom: 0,
    transition: {duration: HERO_SWAP_DUR, ease: HERO_SWAP_EASE},
  }),
};

// Module-scoped flag that survives across remounts of the homepage during
// a single browser session. Hard refresh tears down the JS module and
// resets this back to false → splash plays again. Client-side nav back
// into "/" preserves it → splash + header-hide are skipped so the header
// doesn't blink out and back in.
let splashHasPlayedThisSession = false;

/**
 * Route entry. Picks the static phone layout or the WebGL desktop hero.
 * `isMobileHint` seeds the choice at SSR (UA-based); matchMedia then owns
 * it on the client so a resize across the 768px line swaps layouts. The
 * two trees are separate components so the desktop scroll/RAF/scroll-lock
 * hooks never mount on a phone.
 */
export default function Homepage() {
  const {isMobileHint, featured, heroStacks, stackShips} = useLoaderData<typeof loader>();
  const shopOpen = useRouteLoaderData<RootLoader>('root')?.shopOpen ?? false;
  const strip = shopOpen ? stackShips ?? '' : null;
  const [isMobile, setIsMobile] = useState(isMobileHint);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  if (isMobile) return <MobileHome featured={featured} preorderShips={strip} />;
  return <DesktopHome heroStacks={heroStacks} preorderShips={strip} />;
}

function DesktopHome({
  heroStacks,
  preorderShips,
}: {
  heroStacks: Promise<HeroStacks>;
  /** Set while the shop is open: the strip names the stack's ship date. */
  preorderShips: string | null;
}) {
  // Coming-soon reveal cards keep their link + title but swap the price
  // for a Soon tag (per-card handle resolved server-side on the card).
  const productStatus = useProductStatusResolver();
  const roadmapStatus = useRoadmapStatusResolver();
  const scrollRef = useRef(0);
  const rafId = useRef(0);
  // Scroll progress reaches the DOM two ways:
  //  - visuals (card reveal geometry, scroll-hint fade) read the `--hero-p`
  //    custom property, written imperatively once per scroll frame below -
  //    smooth, and NO React re-render per frame;
  //  - interactivity gates (stack aria-hidden, per-card focus/pointer) are a
  //    small state BITMASK that only changes when a threshold is crossed - a
  //    handful of renders per scroll instead of one per frame. Re-rendering
  //    the whole route at every scroll frame was the single biggest CPU cost
  //    on slow machines. Gate and consumer read the same bit, so the two
  //    can't disagree at a boundary the way a duplicated `> 0.6` check did.
  const heroVarRef = useRef<HTMLDivElement | null>(null);
  // Bit 0: the buy stack is on screen (p >= 0.1). Bits 1..n: card i has
  // revealed past its interactive point (r > 0.6 within its window).
  const [heroGates, setHeroGates] = useState(0);
  const stackVisibleGate = (heroGates & 1) !== 0;
  const cardInteractiveGate = (i: number) => (heroGates & (1 << (i + 1))) !== 0;
  // Which airframe the hero shows - 5-inch or 3-inch. Toggling swaps the
  // GLB trio loaded by HeroScene.
  const [heroSize, setHeroSize] = useState<string>(HERO_START_SIZE);
  const reduceMotion = useReducedMotion();
  // Slide direction for the buy-card swap, mirroring the 3D cross-slide: +1 =
  // moving to a later registry index (new cards fly in from the right, old fly
  // out left), −1 = the reverse. A ref because AnimatePresence reads it via the
  // `custom` prop at exit/enter time - no extra render needed. Written by
  // changeHeroSize before the size state updates.
  const heroSwapDirRef = useRef(1);
  const changeHeroSize = useCallback((next: string) => {
    setHeroSize((prev) => {
      if (next !== prev) {
        const order = HERO_AIRFRAME_KEYS;
        const d = order.indexOf(next) - order.indexOf(prev);
        heroSwapDirRef.current = d < 0 ? -1 : 1;
      }
      return next;
    });
  }, []);
  // Live drag fraction (0→1) while the size slider is dragged, else null. A ref
  // (not state) so dragging it 60×/s doesn't re-render the page - the render
  // loop reads it each frame. The slider writes it; HeroScene reads it.
  const heroScrubRef = useRef<number | null>(null);
  // Which board the visitor is hovering on the right-side product cards, or
  // null. A ref (not state) so hovering doesn't re-render the page; HeroScene
  // reads it each frame to pin that board's spotlight on.
  const heroSpotlightRef = useRef<'fc' | 'esc' | 'frame' | null>(null);
  // Splash starts centered and large. It settles when the 3D scene has
  // finished loading AND a minimum wait has elapsed (so the wordmark
  // always gets a readable beat), or when a max timeout fires as a
  // safety net, or when the user starts scrolling.
  const [splashSettled, setSplashSettled] = useState(
    splashHasPlayedThisSession,
  );
  const [sceneReady, setSceneReady] = useState(splashHasPlayedThisSession);
  const [minWaitElapsed, setMinWaitElapsed] = useState(
    splashHasPlayedThisSession,
  );
  const [isMobile, setIsMobile] = useState(false);
  // Hero-wordmark fill progress, 0..1. Driven by real GLTFLoader byte
  // progress when Content-Length is available, otherwise by the synthetic
  // ramp effect below. Starts at 1 on repeat visits (splash already
  // played) so the wordmark renders fully filled with no animation.
  const [progress, setProgress] = useState(splashHasPlayedThisSession ? 1 : 0);
  // Wireframe phase gate - keep the fill mask fully closed until the
  // stroke-draw animation has played out. Tuned against the CSS:
  // 9 letters × 65ms stagger + 500ms per-letter draw = 1020ms end.
  // Fires a touch before so fill chases the wireframe with no gap.
  const DRAW_PHASE_MS = 950;
  const [drawPhaseDone, setDrawPhaseDone] = useState(
    splashHasPlayedThisSession,
  );
  // Visually displayed progress - JS-lerped toward `progress` so the
  // fill sweeps even when actual load progress jumps from 0 to 1
  // instantly (cached/dev). 0.1 lerp factor → ~95% in ~250ms.
  const [displayedProgress, setDisplayedProgress] = useState(
    splashHasPlayedThisSession ? 1 : 0,
  );
  // Overflow UI - only shown if scene isn't ready within
  // EXPECTED_LOAD_BUDGET_MS. Hidden again as soon as it lands.
  const [showOverflow, setShowOverflow] = useState(false);
  // Tracks whether at least one real (non-synthetic) progress event has
  // come back from GLTFLoader. If not, the time-based ramp drives the
  // wordmark fill so a cached/Content-Length-less load still animates.
  const hasRealProgress = useRef(false);
  const handleSceneReady = useCallback(() => {
    setSceneReady(true);
    setProgress(1);
  }, []);
  // True while a size toggle is waiting on an uncached model build (the
  // background preload usually wins this race, so it's rare). Drives the
  // slider's busy cue so the toggle never looks dead on slow machines.
  const [heroBuilding, setHeroBuilding] = useState(false);
  const handleSceneBuilding = useCallback((building: boolean) => {
    setHeroBuilding(building);
  }, []);
  const handleSceneProgress = useCallback((p: number) => {
    // -1 = lengthComputable false on all 3 GLBs (cached, no
    //      Content-Length). The synthetic ramp keeps moving.
    if (p < 0) return;
    hasRealProgress.current = true;
    // Reserve the last 5% for the sceneReady signal so the fill doesn't
    // hit 100% before the models are actually parsed.
    setProgress((prev) => Math.max(prev, Math.min(p, 0.95)));
  }, []);
  // The splash's manifest board: every piece of the assembly in load order,
  // ticked off as each file lands in the scene. Watching the drone's parts
  // check in one by one is the progress indicator, and on a slow network it
  // says exactly what is still arriving instead of a bare "loading".
  const [loadPieces, setLoadPieces] = useState<
    ReadonlyArray<{id: string; label: string}>
  >([]);
  const [loadDone, setLoadDone] = useState<ReadonlySet<string>>(new Set());
  const [loadActive, setLoadActive] = useState<string | null>(null);
  const handleModelLoad = useCallback(
    (s: HeroLoadState) => {
      setLoadPieces((prev) =>
        prev.length
          ? prev
          : s.pieces.map((p) => ({id: p.id, label: HERO_PIECE_NAMES[p.id] ?? p.label})),
      );
      setLoadActive(s.chunk);
      if (s.done)
        setLoadDone((prev) =>
          prev.has(s.chunk) ? prev : new Set(prev).add(s.chunk),
        );
      handleSceneProgress(s.frac);
    },
    [handleSceneProgress],
  );
  // "drag to rotate" hint - pops up a few seconds after the splash settles if
  // the visitor hasn't touched anything yet, and dismisses on the first drag or
  // scroll. The drone auto-rotates on its own, so this only nudges discovery of
  // the drag-to-view interaction.
  const [showDragHint, setShowDragHint] = useState(false);
  const [interacted, setInteracted] = useState(false);
  // The top product header bar drops in a beat AFTER the rest of the islands
  // have splashed in - 2s after the splash settles - so the hero reads first
  // and the chrome arrives second. Starting to scroll brings it in early. On
  // repeat visits (splash already played) it's in from the first frame. When
  // it lands it shoves the airframe selector down to make room (see the
  // selector's `top` below, which keys off this).
  const [headerIn, setHeaderIn] = useState(splashHasPlayedThisSession);
  // Each product card's reveal window, as fractions of the walkthrough. Derived
  // from where that card's beat actually sits in the sequence (see
  // revealWindows below) rather than from the registry's even spacing: the
  // walkthrough has six beats and only three of them have a card, so evenly
  // spaced windows put the ESC card on screen while the receiver is spotlit.
  const windowsRef = useRef<ReadonlyArray<readonly [number, number]>>(
    HERO_REVEAL_WINDOWS,
  );
  const tick = useCallback(() => {
    const p = scrollRef.current;
    // Smooth visuals: one style-property write, no reconciliation.
    heroVarRef.current?.style.setProperty('--hero-p', p.toFixed(4));
    // Discrete gates: stack visibility (0.1) and each card's interactive
    // threshold (r > 0.6 within its reveal window), packed into a bitmask.
    // setState is a no-op re-render-wise while the mask is unchanged.
    const windows = windowsRef.current;
    let gates = p >= 0.02 ? 1 : 0;
    for (let i = 0; i < windows.length; i++) {
      const [lo, hi] = windows[i];
      if (p > lo + 0.6 * (hi - lo)) gates |= 1 << (i + 1);
    }
    setHeroGates(gates);
    rafId.current = 0;
  }, []);

  // The walkthrough's own position drives --hero-p, which is what the buy-bubble
  // reveal cards and the scroll-hint fades are already keyed off. Previously
  // this came from window.scrollY; the hero no longer scrolls the document, so
  // the sequence is the source of truth.
  // The walkthrough's beat list, once the scene reports it. Each product card
  // reveals as ITS beat is presented, so the card the reader can click always
  // matches the part in the spotlight.
  const [beatIds, setBeatIds] = useState<string[]>([]);
  const handleBeats = useCallback(
    (b: Array<{id: string}>) => setBeatIds(b.map((x) => x.id)),
    [],
  );
  const revealWindows = useMemo<ReadonlyArray<readonly [number, number]>>(() => {
    const n = beatIds.length;
    // Before the scene reports in, fall back to the registry's even spacing so
    // the cards are never left permanently hidden.
    if (n < 2) return HERO_REVEAL_WINDOWS;
    return HERO_SLOTS.map((slot) => {
      const j = beatIds.indexOf(slot.id);
      // A slot with no beat (a future part with no walkthrough step) stays shut
      // rather than popping in at an arbitrary point.
      if (j <= 0) return [1, 1] as const;
      const at = j / (n - 1);
      const prev = (j - 1) / (n - 1);
      // Opens as the previous part leaves, complete by the time this one is
      // presented, so the card lands with the spotlight rather than after it.
      return [prev + 0.45 * (at - prev), at] as const;
    });
  }, [beatIds]);
  useEffect(() => {
    windowsRef.current = revealWindows;
  }, [revealWindows]);

  const handleWalkthroughProgress = useCallback(
    (f: number) => {
      scrollRef.current = Math.max(0, Math.min(1, f));
      if (!rafId.current) rafId.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    // Minimum splash duration - wordmark always gets this long to read.
    const minT = window.setTimeout(() => setMinWaitElapsed(true), 600);
    // Safety cap - if the 3D scene never reports ready (failed fetch,
    // slow device, etc.), release the splash anyway so the UI isn't
    // stuck behind a dim layer forever. Long on purpose: the splash owns
    // the whole load (the manifest board narrates it), so it should only
    // fire when something is actually wrong, not on a slow connection.
    const maxT = window.setTimeout(() => setSplashSettled(true), 12000);
    return () => {
      window.clearTimeout(minT);
      window.clearTimeout(maxT);
    };
  }, []);

  // Splash starts moving to the bottom-left corner as soon as the
  // wireframe phase ends - overlaps with the fill cascade (which runs
  // ~400ms now that the lerp factor was dialled back). The splash
  // transition itself takes ~650ms, so fill and movement share their
  // first ~400ms before the splash continues alone to the corner.
  useEffect(() => {
    if (sceneReady && minWaitElapsed && drawPhaseDone) {
      setSplashSettled(true);
    }
  }, [sceneReady, minWaitElapsed, drawPhaseDone]);

  // Guarantee the wordmark ends fully filled. The displayed-progress lerp
  // is asymptotic and lives in the RAF below, which self-terminates the
  // instant `splashHasPlayedThisSession` flips true. On a fast/cached load
  // the settle can fire in the same commit that opens the fill, killing the
  // loop while displayedProgress is only partway up - freezing letters as
  // half-drawn outlines. Snapping to 1 on settle makes the end state
  // deterministic; on slow loads the RAF has already swept it to ~1 by then,
  // so this is a no-op and the cascade stays visible.
  useEffect(() => {
    if (splashSettled) setDisplayedProgress(1);
  }, [splashSettled]);

  useEffect(() => {
    if (splashHasPlayedThisSession) return;
    const t = window.setTimeout(() => setDrawPhaseDone(true), DRAW_PHASE_MS);
    return () => window.clearTimeout(t);
  }, []);

  // Expected total budget for the intro animation. Models that finish
  // before this stay snappy; anything past it gets the overflow UI.
  const EXPECTED_LOAD_BUDGET_MS = 2000;

  // Unified RAF loop driving BOTH the synthetic time-based progress
  // ramp (used when Content-Length isn't available) AND the displayed
  // progress lerp. Previously these lived in two separate RAFs that
  // competed for scheduler slots during the wireframe phase - merging
  // them halves the scheduler overhead during the critical first
  // 1.5s of page load.
  useEffect(() => {
    if (splashHasPlayedThisSession) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      // Self-terminate once the splash has settled - the closure can
      // outlive the splash phase if the effect dep array doesn't change.
      if (splashHasPlayedThisSession) return;
      // Synthetic ramp - only contributes until a real GLB byte
      // progress event lands. Bumps `progress` toward 0.95 over the
      // load budget so the fill mask has something to chase even when
      // Content-Length is missing.
      if (!hasRealProgress.current) {
        const elapsed = now - start;
        const synth = Math.min(0.95, elapsed / EXPECTED_LOAD_BUDGET_MS);
        setProgress((prev) => (synth > prev ? synth : prev));
      }
      // Displayed-progress lerp. Snappy (factor 0.45) once the
      // wireframe phase ends so the fill is visibly readable during
      // the splash-to-corner transition. Decoupled from byte progress
      // - the fill is a visual beat, not a load indicator.
      setDisplayedProgress((prev) => {
        const target = drawPhaseDone ? 1 : 0;
        const factor = drawPhaseDone ? 0.45 : 0.08;
        return prev + (target - prev) * factor;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [progress, drawPhaseDone, sceneReady]);

  // Show "loading models…" + Skip button if the scene takes longer than
  // the expected budget. Hides immediately when sceneReady fires.
  useEffect(() => {
    if (splashHasPlayedThisSession || sceneReady) {
      setShowOverflow(false);
      return;
    }
    const t = window.setTimeout(
      () => setShowOverflow(true),
      EXPECTED_LOAD_BUDGET_MS,
    );
    return () => window.clearTimeout(t);
  }, [sceneReady]);

  // Drive the site-header drop-in animation from splash state. The
  // header lives outside this component (PageLayout in root.tsx), so
  // we signal via a class on <html> that the header CSS can key off.
  // Class is only meaningful inside `.homepage-layout`, so other pages
  // are unaffected.
  //
  // No cleanup on unmount: once the splash has played in this browser
  // session, the class stays on <html>. Removing it on navigation away
  // caused the header to briefly re-hide when the user came back to "/"
  // via client-side nav (e.g. clicking the wordmark). The class only
  // matters inside `.homepage-layout`, so leaving it set has no effect
  // on other routes.
  useEffect(() => {
    if (!splashSettled) return;
    splashHasPlayedThisSession = true;
    document.documentElement.classList.add('splash-settled');
  }, [splashSettled]);

  // Arm the drag hint ~4s after the splash settles, unless the visitor has
  // already interacted (dragged or scrolled).
  useEffect(() => {
    if (!splashSettled || interacted) return;
    const t = window.setTimeout(() => setShowDragHint(true), 4000);
    return () => window.clearTimeout(t);
  }, [splashSettled, interacted]);

  // First drag (pointerdown anywhere) or first real scroll dismisses the hint
  // for good.
  useEffect(() => {
    if (!splashSettled || interacted) return;
    const done = () => {
      setInteracted(true);
      setShowDragHint(false);
    };
    const onScroll = () => {
      if (window.scrollY > 4) done();
    };
    window.addEventListener('pointerdown', done, {once: true});
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      window.removeEventListener('pointerdown', done);
      window.removeEventListener('scroll', onScroll);
    };
  }, [splashSettled, interacted]);

  // Bring the top header bar in 1s after the splash settles, or immediately if
  // the visitor starts scrolling. Once in, it stays in (and the class persists
  // across SPA nav like splash-settled does, so it doesn't re-hide on return).
  useEffect(() => {
    if (!splashSettled || headerIn) return;
    const t = window.setTimeout(() => setHeaderIn(true), 1000);
    const onScroll = () => {
      if (window.scrollY > 4) setHeaderIn(true);
    };
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('scroll', onScroll);
    };
  }, [splashSettled, headerIn]);

  useEffect(() => {
    if (headerIn) document.documentElement.classList.add('hero-header-in');
  }, [headerIn]);

  // One screen, no spacer. The walkthrough consumes the wheel itself and hands
  // the page back at its last beat, so extra document height would only be dead
  // scroll the reader has to grind through after the drone is done.
  const heroSpacerVh = 100;

  useEffect(() => {
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // The old window-level scroll stepper lived here: it owned the wheel and
  // snapped window.scrollY between four stops. The walkthrough now owns the
  // wheel and its own set points (see HeroDroneScene), so a second stepper
  // would fight it for every gesture. Deleted rather than disabled.

  // Lock page scroll until the intro animation has fully settled. Without
  // this, a flick-scroll mid-animation jumps the splash → settled
  // transform on the wordmark, which looks broken (the wordmark warps
  // mid-stroke). Once the splash has played in this session the lock
  // never re-engages.
  useEffect(() => {
    if (splashHasPlayedThisSession) return;
    if (splashSettled) {
      document.documentElement.style.removeProperty('overflow');
      document.body.style.removeProperty('overflow');
      return;
    }
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.removeProperty('overflow');
      document.body.style.removeProperty('overflow');
    };
  }, [splashSettled]);

  // Per-card reveal windows (shared 0..1 progress with the 3D scene). Each
  // product pops out of the Shop bubble in turn - FC, then ESC, then the frame
  // last. Generated from the parts registry's slot order - the SAME array
  // HeroScene's useFrame reads to spotlight the matching board + pull the
  // camera back as the frame (last card) reveals, so the two sides can no
  // longer drift apart. For the current three slots this is exactly the
  // historical [0.08, 0.3] / [0.4, 0.62] / [0.72, 0.94] (asserted in the
  // registry). Reversing the scroll reverses all of it.
  const REVEAL_WINDOWS = revealWindows;

  return (
    <div className="homepage" ref={heroVarRef}>

      {/*
        Warm the three flagship PDPs (the live handles the 3D part hotspots
        navigate to) so clicking a part is an instant SPA transition with its
        loader data already in cache. The FC hotspot targets openfc-lite -
        the live product; the old `openfc` handle is archived in Shopify.
      */}
      <PrefetchPageLinks page="/products/openfc-lite" />
      <PrefetchPageLinks page="/products/openesc" />
      <PrefetchPageLinks page="/products/openframe" />

      {/*
        Scroll spacer - gives us HERO_SPACER_VH of scroll to drive the
        phased animation. The sticky child below pins the 3D scene + UI to
        the viewport while the user scrolls through the spacer. Once the
        user scrolls past the bottom of the spacer the sticky releases and
        the legal footer (in normal document flow below) comes into view.
      */}
      <div className="relative" style={{height: `${heroSpacerVh}vh`}}>
        <div className="sticky top-0 h-screen overflow-hidden pointer-events-none">
          {/* Full-screen 3D - pinned behind everything via sticky parent */}
          <div
            className={`absolute inset-0 z-0${preorderShips !== null ? ' hero-stage-below-strip' : ''}`}
            style={{
              // Let the browser own vertical panning (page scroll) while
              // horizontal drags still reach the r3f pointer handlers for
              // model rotation. Without this, touch-action defaults to
              // "auto" and the browser cancels the pointer stream as soon
              // as it decides the gesture is a scroll - so on mobile the
              // drag-to-rotate stops working entirely.
              touchAction: 'pan-y',
            }}
          >
            <div className="absolute inset-0 hero-scene-glow" />
            {/* If the WebGL scene crashes (no GPU, lost context, …) the
                boundary releases the splash so the visitor isn't trapped behind
                the dim/scroll-lock - the wordmark + CTAs below stay usable. */}
            <SceneErrorBoundary onError={handleSceneReady} fallback={null}>
              {/* The walkthrough owns the drone AND the scroll: it absorbs the
                  wheel until the reader has seen a beat, then hands the page
                  back at either end. That is why the old window-level scroll
                  stepper is gone - two things cannot own the wheel. */}
              <HeroDroneStage
                size={heroSize}
                onLoad={handleModelLoad}
                onReady={handleSceneReady}
                onProgress={handleWalkthroughProgress}
                onBeats={handleBeats}
              />
            </SceneErrorBoundary>
            {/* Dim overlay - only covers the 3D scene, not the wordmark.
                Fades out once the scene is ready AND the minimum splash
                beat has elapsed. */}
            <div
              className={`scene-dim${splashSettled ? ' is-hidden' : ''}`}
              aria-hidden="true"
            />
          </div>

          {/* Single wordmark - starts centered + large, animates to
              bottom-left at settled size. Inline opacity drives the
              scroll-based fade once the hero starts scrolling away.
              The SVG inside owns the per-letter draw + fill animation;
              progress maps to the GLB load progress (or a synthetic
              ramp when Content-Length is missing).

              While the splash is active we drive `transform` inline
              with a per-frame scale that lerps from 1.95 (during the
              wireframe) down to 1.7 (the CSS-rule splash size). This
              gives a subtle "zoom out as the letters fill in" feel.
              `transition: none` overrides the CSS-rule transition so
              the per-frame scrub stays smooth. Once the splash settles,
              both inline overrides are removed and the CSS rule's
              0.65s transition takes over to slide the wordmark to its
              bottom-left settled position. */}
          {(() => {
            const splashScale = 1.95 - displayedProgress * 0.25;
            return (
              <h1
                className={`hero-wordmark${splashSettled ? ' is-settled' : ''}`}
                style={{
                  // Stays put bottom-left through the whole scroll now - the
                  // brand anchors the hero while the product cards reveal.
                  opacity: 1,
                  ...(splashSettled
                    ? {}
                    : {
                        transform: `translate(calc(50vw - 2.5rem - 50%), calc(-50vh + 2.5rem + 50%)) scale(${splashScale.toFixed(3)})`,
                        transition: 'none',
                      }),
                }}
                aria-label="OpenDrone"
              >
                <HeroWordmark
                  progress={displayedProgress}
                  className={displayedProgress >= 0.99 ? 'is-filled' : ''}
                />
              </h1>
            );
          })()}

          {/* The manifest board. The assembly streams smallest-file-first and
              each piece gets its line: pending is dim, arriving pulses, landed
              ticks off. Part of the splash and leaves with it; on a slow
              network it stays up and names exactly what is still coming. */}
          {/* The manifest and the slow-load escape share one column, so the
              "loading models" line and the Skip button always sit below the
              checklist instead of on top of it. */}
          <div className="hero-load-panel">
          {/* A thin progress bar under the wordmark while the model streams
              in. The per-piece list below it stays for screen readers. */}
          {!splashSettled ? (
            <div
              className="hero-load-bar"
              role="progressbar"
              aria-label={copyText('home.loading_models') ?? 'Loading models'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(displayedProgress * 100)}
            >
              <span style={{transform: `scaleX(${Math.min(1, Math.max(0, displayedProgress))})`}} />
            </div>
          ) : null}
          {!splashSettled && loadPieces.length ? (
            <ul className="hero-load-manifest" role="status" aria-live="polite">
              {loadPieces.map((p) => {
                const state = loadDone.has(p.id)
                  ? 'done'
                  : p.id === loadActive
                    ? 'active'
                    : 'pending';
                return (
                  <li key={p.id} className={`hero-load-piece is-${state}`}>
                    <span className="hero-load-piece__mark" aria-hidden="true">
                      {state === 'done' ? '✓' : state === 'active' ? '▸' : '·'}
                    </span>
                    {p.label}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/* Overflow UI - only renders when the scene takes longer than
              the expected animation budget. Gives the user a way out so
              they aren't trapped behind the dim layer on slow networks. */}
          {showOverflow && !sceneReady ? (
            <div
              className={`hero-load-overflow${splashSettled ? ' is-hidden' : ''}`}
              role="status"
              aria-live="polite"
            >
              <Txt
                id="home.loading_models"
                as="span"
                className="hero-load-overflow__text"
              />
              <Link
                prefetch="viewport"
                to="/collections/all"
                className="hero-load-overflow__skip"
                onClick={() => setSplashSettled(true)}
              >
                <Txt id="home.skip_to_catalog" />
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
            </div>
          ) : null}
          </div>

          {/* GitHub logo - bare mark (no circle), sitting to the right of the
              settled wordmark in the bottom-left corner, centred on the
              wordmark's height. Persists through the scroll. */}
          <a
            href="https://github.com/OpenDrone-hw"
            target="_blank"
            rel="noopener noreferrer"
            className={`hero-github${splashSettled ? ' is-visible' : ''}`}
            style={{opacity: splashSettled ? 1 : 0}}
            aria-label="GitHub"
          >
            <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
          </a>

          {/* Buy bubble - bottom-right. The Shop button is the anchor; as the
              user scrolls, the on-screen hardware (FC → ESC → Frame) pops out
              of it one by one, the stack growing upward. Each card's reveal is
              driven off --hero-p and mirrors the spotlight in HeroScene.
              Scrolling back up retracts them in reverse. */}
          <div
            className={`hero-buy${splashSettled ? ' is-visible' : ''}`}
            style={{opacity: splashSettled ? 1 : 0}}
          >
            <Suspense fallback={null}>
              <Await resolve={heroStacks}>
                {(stacks) => {
                  // The active size's resolved cards, already in [FC, ESC, Frame]
                  // order with the right per-size variant URL + price baked in by
                  // the loader. Index maps directly to the 3D board it spotlights.
                  const items = stacks[heroSize] ?? [];
                  const dir = heroSwapDirRef.current;
                  return (
                    <div className="hero-buy-swap">
                      <AnimatePresence custom={dir} initial={false} mode="sync">
                        <motion.div
                          key={heroSize}
                          className="hero-buy-stack"
                          aria-hidden={!stackVisibleGate}
                          custom={dir}
                          variants={HERO_STACK_SWAP}
                          initial={reduceMotion ? false : 'enter'}
                          animate="center"
                          exit={reduceMotion ? undefined : 'exit'}
                        >
                          {items.slice(0, HERO_SLOTS.length).map((card, i) => {
                            const [lo, hi] = REVEAL_WINDOWS[i] ?? [1, 1];
                            // Interactivity gate only - the reveal GEOMETRY
                            // (max-height/opacity/transform) is CSS driven by
                            // --hero-p + the per-card --lo/--win below, so it
                            // stays per-frame smooth without React renders. The
                            // gate bit is computed in tick(), the single place
                            // that owns the thresholds.
                            const interactive = cardInteractiveGate(i);
                            const setSpot = (v: HeroBoardKey | null) => {
                              heroSpotlightRef.current = v;
                            };
                            // A concept product (planned / in-progress) has
                            // no settled render or name to preview; its slot
                            // stays empty so the other cards keep their
                            // reveal windows.
                            if (
                              isConceptFor(
                                card.handle,
                                roadmapStatus(card.handle),
                              )
                            )
                              return null;
                            return (
                              <Link
                                key={card.boardKey}
                                to={card.url}
                                prefetch="intent"
                                className="hero-reveal-card"
                                style={
                                  {
                                    '--lo': lo,
                                    '--win': hi - lo,
                                    pointerEvents: interactive
                                      ? 'auto'
                                      : 'none',
                                  } as React.CSSProperties
                                }
                                tabIndex={interactive ? undefined : -1}
                                aria-hidden={!interactive}
                                onMouseEnter={() => setSpot(card.boardKey)}
                                onMouseLeave={() => setSpot(null)}
                                onFocus={() => setSpot(card.boardKey)}
                                onBlur={() => setSpot(null)}
                              >
                                <span className="hero-reveal-media">
                                  {card.image?.url ? (
                                    <img
                                      src={shopifyImageUrl(card.image.url, 160)}
                                      alt={card.image.altText ?? ''}
                                      loading="lazy"
                                      decoding="async"
                                    />
                                  ) : (
                                    <span
                                      className="hero-reveal-ph"
                                      aria-hidden="true"
                                    />
                                  )}
                                </span>
                                <span className="hero-reveal-text">
                                  <span className="hero-reveal-title">
                                    {card.title}
                                  </span>
                                  {card.productType ? (
                                    <span className="hero-reveal-sub">
                                      {card.productType}
                                    </span>
                                  ) : null}
                                </span>
                                {!isPurchasableStatus(
                                  productStatus(card.handle),
                                ) ? (
                                  <Txt
                                    id="home.reveal_soon"
                                    as="span"
                                    className="hero-reveal-soon"
                                  />
                                ) : card.price ? (
                                  <span className="hero-reveal-price">
                                    {formatPrice(
                                      card.price.amount,
                                      card.price.currencyCode,
                                    )}
                                  </span>
                                ) : null}
                              </Link>
                            );
                          })}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  );
                }}
              </Await>
            </Suspense>
            <Link
              prefetch="viewport"
              to="/collections/all"
              className="hero-action-primary hero-buy-btn"
            >
              <Txt id="home.shop" />
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Link>
          </div>

          {/* Top centre: the preorder line while the shop is open, then the
            airframe size toggle when more than one assembly is built. Stays
            visible through the scroll so both are always reachable. */}
          <div
            className="hero-top-center absolute left-1/2 -translate-x-1/2 z-20 pointer-events-auto"
            style={{
              // Springs down from the top edge when the splash settles, resting
              // high (2.5rem). When the header bar lands ~2s later it shoves the
              // selector down to 6rem - the spring `top` transition sells the push.
              top: !splashSettled ? '-3rem' : headerIn ? '6rem' : '2.5rem',
              opacity: splashSettled ? 1 : 0,
              transition:
                'top 0.7s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease',
            }}
          >
            {preorderShips !== null ? <PreorderStrip ships={preorderShips || null} /> : null}
            {HERO_SIZES.length > 1 ? (
              <HeroSizeSlider
                value={heroSize}
                onChange={changeHeroSize}
                scrubRef={heroScrubRef}
                busy={heroBuilding}
              />
            ) : null}
          </div>

          {/* Scroll hint - fade driven by --hero-p in CSS (see .hero-scroll-fade)
            so it tracks every scroll frame without a React render. */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 hero-scroll-fade">
            <div className="w-px h-5 bg-gradient-to-b from-[var(--color-text-muted)] to-transparent animate-pulse" />
          </div>

          {/* Drag-to-view hint - appears a few seconds in if the visitor hasn't
            touched the drone yet, dismissed on first drag/scroll. */}
          <div
            className={`hero-drag-hint${showDragHint ? ' is-visible' : ''}`}
            aria-hidden="true"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="7 8 3 12 7 16" />
              <polyline points="17 8 21 12 17 16" />
              <line x1="3" y1="12" x2="21" y2="12" />
            </svg>
            <Txt id="home.drag_hint" />
          </div>

          {/* Scroll-to-explore cue - anchored at the bottom of the hero, shares the
            drag hint's lifecycle (fades in a few seconds in, dismissed on the
            first drag/scroll). */}
          <div
            className={`hero-scroll-hint${showDragHint ? ' is-visible' : ''}`}
            aria-hidden="true"
          >
            <Txt id="home.scroll_hint" />
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="8 7 12 11 16 7" />
              <polyline points="8 13 12 17 16 13" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
