/**
 * The hero's 3D layer: the scroll-driven walkthrough, its progress rail, and the
 * copy panel that follows it.
 *
 * This is an absolutely-positioned layer, not a section of its own - it fills
 * the hero's sticky pane so the wordmark, size selector and buy bubble sit over
 * the same drone. The route owns the splash; this owns the drone.
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
import {Txt} from '~/components/Txt';
import {WHAT_IS_THIS_ID} from '~/lib/product-content';

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
const scenePromise =
  typeof window !== 'undefined' && shouldLoad3D()
    ? import('~/components/HeroDroneScene')
    : null;

/** Link label for a beat: the chapter's own title when the href points at
 *  the What-does-this-do chapter, the generic product link otherwise. */
function BeatLinkLabel({href}: {href: string}) {
  return href.endsWith(`#${WHAT_IS_THIS_ID}`) ? (
    <Txt id="product-chrome.ch_what_is_this_title" fallback="What does this do?" />
  ) : (
    <Txt id="home.walkthrough_link" fallback="See the product" />
  );
}

export function HeroDroneStage({
  model,
  size,
  onLoad,
  onReady,
  onProgress,
  onBeat,
  onBeats,
}: {
  model?: string;
  size?: string;
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
    if (!shouldLoad3D() || !scenePromise) {
      // Tell the route now, or it sits behind the splash's dim layer waiting out
      // the safety timeout on a machine that will never show a drone.
      onReady?.();
      return;
    }
    setUse3D(true);
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
          During a rest the panel clears entirely: the whole drone is the
          content, and a caption would race ahead of the next part. */}
      {use3D && !resting && shown ? (
        <div className="hp-copy" key={shown.id} aria-live="polite">
          {/* No step counter: the rail's dots already say where you are. */}
          <h2 className="hp-title">{shown.title}</h2>
          <p className="hp-note">{shown.note}</p>
          {/* Beginner explainer: what the part does, one line of how it
              connects, and the product page when we sell it. Strings come
              from studio.json with the rest of the beat copy. */}
          {shown.caption ? <p className="hp-explain">{shown.caption}</p> : null}
          {shown.hint ? <p className="hp-connect">{shown.hint}</p> : null}
          {shown.href ? (
            <Link className="hp-copy-link" to={shown.href} prefetch="intent">
              <BeatLinkLabel href={shown.href} />
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden="true"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* Every beat's copy in the DOM, always. Without this most of the text
          exists only in JS state: invisible to crawlers, to screen readers, and
          to anyone whose device never loads the scene. */}
      <ul className="hp-fallback">
        {beats.map((b) => {
          // A beat with mid-hold stops carries its copy on the stops (the
          // beat-level title/note duplicate the first stop), so render those
          // instead of the beat's own.
          const entries = b.stops?.length
            ? b.stops.map((s, j) => ({...s, id: `${b.id}:${j}`}))
            : [{...b, id: b.id}];
          return entries.map((e) => (
            <li key={e.id}>
              <h3>{e.title}</h3>
              <p>{e.note}</p>
              {e.caption ? <p>{e.caption}</p> : null}
              {e.hint ? <p>{e.hint}</p> : null}
              {e.href ? (
                <Link to={e.href}>
                  <BeatLinkLabel href={e.href} />
                </Link>
              ) : null}
            </li>
          ));
        })}
      </ul>
    </div>
  );
}
