import {useEffect, useRef, useState} from 'react';
import {animate, motion, useMotionValue, useReducedMotion} from 'motion/react';
import {HERO_AIRFRAMES} from '~/lib/hero-airframes';

// Sizes + labels come from the single hero registry (app/lib/hero-airframes.ts)
// so adding an airframe is a config edit there, not a change here.
type Size = string;
const SIZES: Size[] = HERO_AIRFRAMES.map((a) => a.key);
const LABELS: Record<Size, string> = Object.fromEntries(
  HERO_AIRFRAMES.map((a) => [a.key, a.label]),
);

const PAD = 5; // px - must match .hero-size-slider padding in app.css
// The "other" side for the 2-position drag. NOTE: the drag-scrub gesture is
// built for exactly two positions (the registry's first two). A 3rd+ size still
// renders as a click-to-select button and swaps correctly; only the drag would
// need a segmented rework.
const other = (s: Size): Size => SIZES.find((k) => k !== s) ?? s;

/**
 * Airframe size control for the hero. A gold thumb you drag between 5″ and 3″.
 *
 * The drag is a true 1:1 scrub: on drag-start we commit the *target* size,
 * which sets up HeroScene's cross-slide swap; then each drag frame writes the
 * thumb's fraction into `scrubRef`, which HeroScene reads to position the
 * airframe - so the model tracks the thumb continuously. Release past the
 * midpoint keeps the target; short of it, it reverts (the model slides back).
 *
 * The two labels are real buttons, so the control also works by click +
 * keyboard with no drag (those take the plain timed transition). Reduced-motion
 * snaps the thumb; the scrub still works but HeroScene's own reduced-motion
 * handling governs the 3D.
 */
export function HeroSizeSlider({
  value,
  onChange,
  scrubRef,
  busy = false,
}: {
  value: Size;
  onChange: (v: Size) => void;
  /** Shared ref the hero reads each frame for the live scrub fraction. */
  scrubRef: React.RefObject<number | null>;
  /** True while the target size's model is still building (uncached toggle).
   *  Shows a small spinner in the thumb so the wait reads as loading, not a
   *  dead control. The toggle stays interactive throughout. */
  busy?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const [dragging, setDragging] = useState(false);
  // Which side the thumb is currently over while dragging (drives the active
  // label). Only changes when the thumb crosses the midpoint, so no per-frame
  // re-render. null when idle → fall back to `value`.
  const [preview, setPreview] = useState<Size | null>(null);
  const reduce = useReducedMotion();

  // Where the drag began, and which size it's heading toward. Captured at
  // drag-start so direction is stable for the whole gesture.
  const fromRef = useRef<Size>(value);
  const targetRef = useRef<Size>(other(value));

  const travel = () => {
    const el = trackRef.current;
    if (!el) return 0;
    return (el.clientWidth - PAD * 2) / 2;
  };
  const slotX = (v: Size) => (v === SIZES[0] ? 0 : travel());

  // Park the thumb on the committed side when value changes from outside a
  // drag (click, keyboard, or a settled drag). Never while dragging.
  useEffect(() => {
    if (dragging) return;
    const dest = slotX(value);
    if (reduce) {
      x.set(dest);
      return;
    }
    const controls = animate(x, dest, {type: 'spring', stiffness: 360, damping: 34});
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, dragging, reduce]);

  function onDragStart() {
    const from = value;
    fromRef.current = from;
    targetRef.current = other(from);
    setDragging(true);
    setPreview(from);
    // Commit the target now so HeroScene sets up the cross-slide swap; the
    // scrub (starting at 0) holds it showing `from` until the thumb moves.
    scrubRef.current = 0;
    onChange(targetRef.current);
  }

  function onDrag() {
    const t = travel();
    if (t <= 0) return;
    const frac = Math.min(1, Math.max(0, Math.abs(x.get() - slotX(fromRef.current)) / t));
    scrubRef.current = frac;
    const side = frac > 0.5 ? targetRef.current : fromRef.current;
    setPreview((p) => (p === side ? p : side));
  }

  function onDragEnd() {
    const t = travel();
    const frac = t > 0 ? Math.abs(x.get() - slotX(fromRef.current)) / t : 0;
    const final = frac > 0.5 ? targetRef.current : fromRef.current;
    scrubRef.current = null;
    setDragging(false);
    setPreview(null);
    onChange(final); // commit (no-op if already target) or revert (slides back)
  }

  const active = preview ?? value;

  return (
    <div
      className="hero-size-slider"
      role="group"
      aria-label="Airframe size"
      aria-busy={busy || undefined}
      ref={trackRef}
    >
      <motion.div
        className={`hero-size-slider__thumb${busy ? ' is-busy' : ''}`}
        aria-hidden="true"
        style={{x}}
        drag="x"
        dragConstraints={trackRef}
        dragElastic={0.04}
        dragMomentum={false}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        whileTap={{scale: 0.97}}
      >
        <span className="hero-size-slider__thumb-label">{LABELS[active]}</span>
        {busy ? (
          <span className="hero-size-slider__spinner" aria-hidden="true" />
        ) : null}
      </motion.div>
      {SIZES.map((s) => (
        <button
          key={s}
          type="button"
          className={`hero-size-slider__opt${active === s ? ' is-active' : ''}`}
          aria-label={LABELS[s]}
          aria-pressed={value === s}
          onClick={() => onChange(s)}
        >
          {LABELS[s]}
        </button>
      ))}
    </div>
  );
}
