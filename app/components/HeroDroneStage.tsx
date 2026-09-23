/**
 * The hero's 3D layer: the scroll-driven walkthrough, the caption panel that
 * explains each step, and the rail of step buttons.
 *
 * This is an absolutely-positioned layer, not a section of its own: it fills
 * the hero's sticky pane. The route owns the splash; this owns the drone, the
 * caption panel (counter, part role, what it does, the product line) and the
 * one Shop button. The words come from studio.json (app/lib/home-tour.ts).
 *
 * Rendering rules live here rather than in the scene: the 3D is skipped under
 * 768px or `prefers-reduced-motion`, matching the policy the rest of the
 * homepage uses, and in that case the step list becomes the actual content
 * instead of being visually hidden.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import type {
  HeroBeat,
  HeroDroneSceneProps,
  HeroLoadState,
} from '~/components/HeroDroneScene';
import {TourCaption, TourShop} from '~/components/TourCaption';
import {copyText} from '~/lib/copy';
import type {TourProducts} from '~/lib/home-tour';
import {HOME_TOUR_STEPS} from '~/lib/home-tour-steps';

function shouldLoad3D() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (window.innerWidth < 768) return false;
  return true;
}

// three.js and the scene are a large chunk, and mobile renders a static page
// instead, so this must stay a dynamic import or every phone downloads a
// renderer it never uses. Started at module eval rather than in an effect so it
// races hydration; the type-only import above adds no runtime dependency.
// Only on a page that shows the stage: other routes can evaluate this module
// through a prefetched home route, and must not pull three.js with it.
const loadScene = () => import('~/components/HeroDroneScene');
let scenePromise: ReturnType<typeof loadScene> | null =
  typeof window !== 'undefined' &&
  /^\/(hero-preview)?$/.test(window.location.pathname) &&
  shouldLoad3D()
    ? loadScene()
    : null;

export function HeroDroneStage({
  model,
  size,
  products = {},
  onLoad,
  onReady,
  onProgress,
  onBeat,
  onBeats,
}: {
  model?: string;
  size?: string;
  /** The shop's product per handle, for the product lines. A handle that is
   *  missing gets no product line. */
  products?: TourProducts;
  /** Model download progress, for the route's splash. */
  onLoad?: (s: HeroLoadState) => void;
  /** Fires once the drone is rigged and the walkthrough is live. */
  onReady?: () => void;
  /** Walkthrough position 0..1, every frame. */
  onProgress?: (f: number) => void;
  /** Presented step, or null while the drone rests whole between parts. */
  onBeat?: (beat: HeroBeat | null, index: number) => void;
  /** Every step once known, in order. */
  onBeats?: (beats: HeroBeat[]) => void;
}) {
  // The homepage drives this from its size selector. The scene falls back to
  // the 3 inch if the requested design has no assembly built yet, so adding
  // od5/ later is the only step needed to light this up.
  const folder = model ?? `od${size ?? '3'}`;
  // pending until mounted, then 3d or static (no 3D: the step list is the page).
  const [mode, setMode] = useState<'pending' | '3d' | 'static'>('pending');
  const [Scene, setScene] = useState<React.ComponentType<HeroDroneSceneProps> | null>(
    null,
  );
  useEffect(() => {
    if (!shouldLoad3D()) {
      setMode('static');
      // Tell the route now, or it sits behind the splash's dim layer waiting out
      // the safety timeout on a machine that will never show a drone.
      onReady?.();
      return;
    }
    setMode('3d');
    scenePromise ??= loadScene();
    scenePromise
      .then((m) => setScene(() => m.HeroDroneScene))
      .catch((err) => {
        console.error('[hero] failed to load the 3D scene chunk:', err);
        setMode('static');
        onReady?.();
      });
  }, [onReady]);

  // The bundled steps render on the server and until the scene reports its
  // own (the same file, read at runtime so /studio edits show live).
  const [steps, setSteps] = useState<HeroBeat[]>(HOME_TOUR_STEPS);
  // The step the caption panel shows. It follows the spotlight, and holds the
  // last part's step while the drone rests whole between two parts.
  const [active, setActive] = useState(0);
  const seek = useRef<((i: number) => void) | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  // The panel's height, for layouts that stack the rail above it as a sheet.
  useEffect(() => {
    const panel = panelRef.current;
    const stage = stageRef.current;
    if (!panel || !stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() =>
      stage.style.setProperty('--tour-sheet-h', `${panel.offsetHeight}px`),
    );
    ro.observe(panel);
    return () => ro.disconnect();
  }, [mode]);

  // A rail jump flies past the parts in between. The panel shows the
  // destination at once and ignores the fly-past until it lands.
  const jumpTo = useRef<{step: number; until: number} | null>(null);
  const handleBeat = useCallback(
    (b: HeroBeat | null, i: number) => {
      const jump = jumpTo.current;
      if (jump && performance.now() < jump.until && i !== jump.step) {
        onBeat?.(b, i);
        return;
      }
      jumpTo.current = null;
      if (b && i >= 0) setActive(i);
      onBeat?.(b, i);
    },
    [onBeat],
  );
  const handleBeats = useCallback(
    (b: HeroBeat[]) => {
      if (b.length) setSteps(b);
      onBeats?.(b);
    },
    [onBeats],
  );
  const onSeeker = useCallback((fn: (i: number) => void) => {
    seek.current = fn;
  }, []);
  // Fires every frame, so it writes straight to the DOM rather than to state.
  const handleProgress = useCallback(
    (f: number) => {
      if (fillRef.current)
        fillRef.current.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
      onProgress?.(f);
    },
    [onProgress],
  );

  const total = steps.length;
  const current = steps[Math.min(active, total - 1)];
  const last = active >= total - 1;
  const productOf = (st: HeroBeat) => (st.handle ? products[st.handle] : undefined);

  return (
    <div ref={stageRef} className={`hp-stage${mode === 'static' ? ' is-static' : ''}`}>
      {Scene ? (
        <Scene
          model={folder}
          onBeat={handleBeat}
          onBeats={handleBeats}
          onProgress={handleProgress}
          onLoad={onLoad}
          onReady={onReady}
          onSeeker={onSeeker}
        />
      ) : null}

      {mode !== 'static' && current ? (
        <aside ref={panelRef} className="tour-panel" aria-label={copyText('home.tour_label') ?? undefined}>
          {/* Keyed on the step so each new step's words fade in. */}
          <div className="tour-panel-body" key={current.id} aria-live="polite">
            <TourCaption
              step={current}
              index={active}
              total={total}
              product={productOf(current)}
            />
          </div>
          <TourShop primary={last} />
        </aside>
      ) : null}

      {mode !== 'static' ? (
        <nav className="hp-rail" aria-label={copyText('home.tour_label') ?? undefined}>
          <div className="hp-rail-fill" ref={fillRef} />
          {steps.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={`hp-dot${i === active ? ' on' : ''}${i < active ? ' done' : ''}`}
              style={{left: `${(i / Math.max(1, total - 1)) * 100}%`}}
              aria-label={`${i + 1}. ${b.title}`}
              aria-current={i === active ? 'step' : undefined}
              onClick={() => {
                jumpTo.current = {step: i, until: performance.now() + 4000};
                setActive(i);
                seek.current?.(i);
              }}
            >
              <span className="hp-dot-label" aria-hidden="true">
                {b.title}
              </span>
            </button>
          ))}
        </nav>
      ) : null}

      {/* Every step in the DOM, always, for crawlers, screen readers and
          devices that never load the scene; the page itself when there is
          no 3D. */}
      <ol className="hp-fallback">
        {steps.map((b, i) => (
          <li key={b.id}>
            <TourCaption step={b} index={i} total={total} product={productOf(b)} as="h3" />
          </li>
        ))}
        {mode === 'static' ? (
          <li>
            <TourShop primary />
          </li>
        ) : null}
      </ol>
    </div>
  );
}
