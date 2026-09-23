import {PrefetchPageLinks, useLoaderData, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {CAMPAIGN} from '~/lib/catalog-client';
import {PreorderStrip, type HomePrices} from '~/components/PreorderStrip';
import type {Route} from './+types/_index';
import {useEffect, useRef, useState, useCallback} from 'react';
import type {ProductCardFragment} from '~/lib/product-shapes';
import {byHandle, formatPrice, toCard} from '~/lib/catalog';
import {INCUTEC_HINT_SEEN_KEY} from '~/lib/incutec-hint';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {HeroDroneStage} from '~/components/HeroDroneStage';
import type {HeroLoadState} from '~/components/HeroDroneScene';
import {HeroWordmark} from '~/components/HeroWordmark';
import {HeroSizeSlider} from '~/components/HeroSizeSlider';
import {HERO_AIRFRAME_KEYS} from '~/lib/hero-airframes';
import {MobileHome} from '~/components/MobileHome';
import {SceneErrorBoundary} from '~/components/SceneErrorBoundary';
import {copyText} from '~/lib/copy';

/**
 * The homepage's words live in `content/copy/home.json` (shared with
 * `MobileHome`) and, for the walkthrough's steps, in the studio.json beats
 * (app/lib/home-tour.ts); the build picks come from content/builds.json. Everything else here is machinery: scroll progress,
 * splash phases, the `--hero-p` custom property. Product titles, prices and
 * the load manifest's piece labels are runtime data, not editable strings.
 */
export const meta: Route.MetaFunction = ({location}) =>
  buildSeoMeta({
    // buildSeoMeta appends "| OpenDrone"; don't repeat the brand here.
    title: copyText('home.meta_title') ?? 'Open Source Drone Parts',
    description: copyText('home.meta_description') ?? '',
    url: `${SITE_ORIGIN}${location.pathname}`,
  });

type HomeProduct = ProductCardFragment;
type HomeFeaturedResult = {
  frame: HomeProduct | null;
  rx: HomeProduct | null;
  fc: HomeProduct | null;
  esc: HomeProduct | null;
  motor: HomeProduct | null;
};

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
  'board-4in1-mini': 'OpenESC 20x20',
  'board-OpenFC': 'OpenFC Lite 20x20',
  'board-OpenRX-Lite-UFL': 'OpenRX Lite-UFL',
};
const HERO_SIZES = HERO_AIRFRAME_KEYS.filter((k) => HERO_BUILT_SIZES.includes(k));
const HERO_START_SIZE = HERO_SIZES[0] ?? HERO_AIRFRAME_KEYS[0];

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
    prices: HomePrices;
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
        // The promo line: the lowest current price per product.
        prices: {
          'openfc-lite': fromPrice(d.fc),
          openesc: fromPrice(d.esc),
          openrx: fromPrice(d.rx),
        },
      };
    })
    .catch(() => ({
      featured: [],
      prices: {},
    }));

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

  // The promo line paints with the first HTML on every layout, so its
  // prices are awaited. The catalog is worker-cached, the same fetch the
  // phone layout already awaits.
  const {prices} = await home;

  return {isMobileHint, featured, stackShips, prices};
}

/** A product's lowest current price, formatted, or null. */
function fromPrice(p: HomeProduct | null): string | null {
  const min = p?.priceRange?.minVariantPrice;
  return min ? formatPrice(min.amount, min.currencyCode) || null : null;
}

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
  const {isMobileHint, featured, stackShips, prices} = useLoaderData<typeof loader>();
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

  if (isMobile)
    return (
      <MobileHome featured={featured} preorderShips={strip} prices={prices} />
    );
  return <DesktopHome preorderShips={strip} prices={prices} />;
}

function DesktopHome({
  preorderShips,
  prices,
}: {
  /** Set while the shop is open: the promo line names the stack's ship date. */
  preorderShips: string | null;
  prices: HomePrices;
}) {
  const scrollRef = useRef(0);
  const rafId = useRef(0);
  // Scroll progress reaches the DOM as the `--hero-p` custom property (the
  // scroll-hint fade reads it), written imperatively once per frame below:
  // no React re-render per frame.
  const heroVarRef = useRef<HTMLDivElement | null>(null);
  // Which airframe the hero shows. The toggle appears once two are built.
  const [heroSize, setHeroSize] = useState<string>(HERO_START_SIZE);
  const changeHeroSize = useCallback((next: string) => setHeroSize(next), []);
  // Live drag fraction (0→1) while the size slider is dragged, else null. A ref
  // (not state) so dragging it 60×/s doesn't re-render the page - the render
  // loop reads it each frame. The slider writes it; HeroScene reads it.
  const heroScrubRef = useRef<number | null>(null);
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
  const tick = useCallback(() => {
    heroVarRef.current?.style.setProperty('--hero-p', scrollRef.current.toFixed(4));
    rafId.current = 0;
  }, []);

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

  // Once the splash has played in this browser session it stays settled,
  // also after client-side navigation back to "/".
  useEffect(() => {
    if (!splashSettled) return;
    splashHasPlayedThisSession = true;
    document.documentElement.classList.add('splash-settled');
  }, [splashSettled]);

  // 3s after load, drop a small "Who's incutec?" hint
  // out from under the Incutec mark, nudging discovery of the company page.
  // Once the visitor has clicked through (flag in localStorage) the hint is
  // retired - don't arm it, and clear any stale class from this session.
  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem(INCUTEC_HINT_SEEN_KEY) === '1';
    } catch {
      /* storage blocked - treat as not-yet-seen */
    }
    if (seen) {
      document.documentElement.classList.remove('hero-incutec-hint');
      return;
    }
    const t = window.setTimeout(
      () => document.documentElement.classList.add('hero-incutec-hint'),
      3000,
    );
    return () => window.clearTimeout(t);
  }, []);

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

  return (
    <div className="homepage" ref={heroVarRef}>

      {/*
        Warm the three flagship PDPs the walkthrough's picks and part clicks
        open, so following one is an instant SPA transition with its loader
        data already in cache.
      */}
      <PrefetchPageLinks page="/products/openfc-lite" />
      <PrefetchPageLinks page="/products/openesc" />
      <PrefetchPageLinks page="/products/openframe" />

      {/*
        One screen: the sticky child pins the 3D scene and its UI while the
        walkthrough owns the wheel; past its last step the page scrolls on
        to the footer.
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

          {/* The splash wordmark: centred and large, its letters drawn and
              filled as the models stream in (the SVG owns that animation;
              progress is the GLB load, or a synthetic ramp without
              Content-Length). While the splash runs, `transform` is driven
              inline, 1.95 down to 1.7, with `transition: none` so the scrub
              stays smooth. Once it settles it fades out in place (see
              .hero-wordmark.is-settled). */}
          {(() => {
            const splashScale = 1.95 - displayedProgress * 0.25;
            return (
              <h1
                className={`hero-wordmark${splashSettled ? ' is-settled' : ''}`}
                style={{
                  // The splash's wordmark fades out where it stands once the
                  // drone is ready: the header carries the brand.
                  opacity: splashSettled ? 0 : 1,
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

          </div>

          {/* Promo line, full width under the header while the shop is
            open. Paints with the page; it never waits for the models. */}
          {preorderShips !== null ? (
            <div className="hero-promo pointer-events-auto">
              <PreorderStrip ships={preorderShips || null} prices={prices} />
            </div>
          ) : null}

          {/* Top centre: the airframe size toggle when more than one assembly
            is built. Stays visible through the scroll. */}
          <div
            className="hero-top-center absolute left-1/2 -translate-x-1/2 z-20 pointer-events-auto"
            style={{
              // Springs down from the top edge when the splash settles, below
              // the header, and below the promo line while the shop is open.
              top: !splashSettled
                ? '-3rem'
                : preorderShips !== null
                  ? '8rem'
                  : '6rem',
              opacity: splashSettled ? 1 : 0,
              transition:
                'top 0.7s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease',
            }}
          >
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

        </div>
      </div>
    </div>
  );
}
