/**
 * The hero's 3D layer: the scroll-driven walkthrough, its progress rail, and the
 * copy panel that follows it.
 *
 * This is an absolutely-positioned layer, not a section of its own - it fills
 * the hero's sticky pane so the wordmark, size selector and buy bubble sit over
 * the same drone. The route owns the splash; this owns the drone and the one
 * label line per part ("OpenFC Lite · 20x20 / 30x30 · 3-6S / 3-8S · €23.20").
 *
 * Rendering rules live here rather than in the scene: the 3D is skipped under
 * 768px or `prefers-reduced-motion`, matching the policy the rest of the
 * homepage uses, and in that case the fallback list becomes the actual content
 * instead of being visually hidden.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {Link} from 'react-router';
import type {
  HeroBeat,
  HeroDroneSceneProps,
  HeroLoadState,
} from '~/components/HeroDroneScene';
import type {HomePrices} from '~/components/PreorderStrip';

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

/** One label line: name, spec note, price, linked to the product when the
 *  part is sold here. */
function BeatLabel({
  beat,
  prices,
  className,
}: {
  beat: Pick<HeroBeat, 'title' | 'note' | 'handle' | 'href'>;
  prices?: HomePrices;
  className: string;
}) {
  const price = beat.handle ? prices?.[beat.handle] : null;
  const text = [beat.note, price].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="hp-label-name">{beat.title}</span>
      {text ? <span className="hp-label-meta">{text}</span> : null}
    </>
  );
  return beat.href ? (
    <Link className={className} to={beat.href} prefetch="intent">
      {body}
    </Link>
  ) : (
    <span className={className}>{body}</span>
  );
}

export function HeroDroneStage({
  model,
  size,
  prices,
  onLoad,
  onReady,
  onProgress,
  onBeat,
  onBeats,
}: {
  model?: string;
  size?: string;
  /** Price per product handle for the label lines. */
  prices?: HomePrices;
  /** Model download progress, for the route's splash. */
  onLoad?: (s: HeroLoadState) => void;
  /** Fires once the drone is rigged and the walkthrough is live. */
  onReady?: () => void;
  /** Walkthrough position 0..1, every frame. */
  onProgress?: (f: number) => void;
  /** Presented beat, or null while the drone rests whole between parts. */
  onBeat?: (beat: HeroBeat | null, index: number) => void;
  /** The whole beat list once known, in order. */
  onBeats?: (beats: HeroBeat[]) => void;
}) {
  // The homepage drives this from its size selector. The scene falls back to
  // the 3 inch if the requested design has no assembly built yet, so adding
  // od5/ later is the only step needed to light this up.
  const folder = model ?? `od${size ?? '3'}`;
  const [use3D, setUse3D] = useState(false);
  const [Scene, setScene] = useState<React.ComponentType<HeroDroneSceneProps> | null>(
    null,
  );
  useEffect(() => {
    if (!shouldLoad3D()) {
      // Tell the route now, or it sits behind the splash's dim layer waiting out
      // the safety timeout on a machine that will never show a drone.
      onReady?.();
      return;
    }
    setUse3D(true);
    scenePromise ??= loadScene();
    scenePromise
      .then((m) => setScene(() => m.HeroDroneScene))
      .catch((err) => {
        console.error('[hero] failed to load the 3D scene chunk:', err);
        onReady?.();
      });
  }, [onReady]);

  const [beats, setBeats] = useState<HeroBeat[]>([]);
  const [active, setActive] = useState(0);
  // The copy the scene is presenting RIGHT NOW: the beat's, or an active
  // mid-hold stop's (same shape, different id). The panel renders this rather
  // than looking the beat up in `beats`, or a stop's caption change could
  // never show.
  const [shown, setShown] = useState<HeroBeat | null>(null);
  // True while the drone rests whole between parts (the scene reports beat
  // null). The copy panel clears; the rail keeps the last part's dot lit.
  // Starts true: the scene only reports once something is presented (the
  // opening whole-drone hold reports too, carrying the beginner intro).
  const [resting, setResting] = useState(true);
  const seek = useRef<((i: number) => void) | null>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  const handleBeat = useCallback(
    (b: HeroBeat | null, i: number) => {
      setResting(!b);
      if (b) setShown(b);
      if (b && i >= 0) setActive(i);
      onBeat?.(b, i);
    },
    [onBeat],
  );
  const handleBeats = useCallback(
    (b: HeroBeat[]) => {
      setBeats(b);
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

  return (
    <div className="hp-stage">
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

      {use3D ? (
        <nav className="hp-rail" aria-label="Drone parts">
          <div className="hp-rail-fill" ref={fillRef} />
          {beats.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={`hp-dot${i === active ? ' on' : ''}${i < active ? ' done' : ''}`}
              style={{left: `${(i / Math.max(1, beats.length - 1)) * 100}%`}}
              aria-label={b.title}
              aria-current={i === active ? 'true' : undefined}
              onClick={() => seek.current?.(i)}
            />
          ))}
        </nav>
      ) : null}

      {/* The spotlight cuts as a part leaves; that is the cue for this.
          During a rest the label clears: the whole drone is the content. */}
      {use3D && !resting && shown ? (
        <div className="hp-copy" key={shown.id} aria-live="polite">
          <BeatLabel beat={shown} prices={prices} className="hp-label" />
        </div>
      ) : null}

      {/* Every label in the DOM, always, for crawlers, screen readers and
          devices that never load the scene. */}
      <ul className="hp-fallback">
        {beats.flatMap((b) =>
          // A beat with mid-hold stops carries its labels on the stops.
          (b.stops?.length ? b.stops.map((st, j) => ({...st, id: `${b.id}:${j}`})) : [b]).map(
            (e) => (
              <li key={e.id}>
                <BeatLabel beat={e} prices={prices} className="hp-label" />
              </li>
            ),
          ),
        )}
      </ul>
    </div>
  );
}
