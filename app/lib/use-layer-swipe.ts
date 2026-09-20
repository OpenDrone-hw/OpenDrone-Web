import {useEffect, useRef, useState} from 'react';

export type LayerSwipe = {
  /** Live drag offset as a fraction of one card width: 0 at rest, -1 = dragged a
   *  full card left (peeling toward the next layer), +1 = right (previous). */
  drag: number;
  /** True while a horizontal drag is in progress - kills the snap transition so
   *  the layers track the finger 1:1; clears on release to animate the settle. */
  dragging: boolean;
};

/**
 * Drag-to-peel paging for a horizontal stack (board copper layers, schematic
 * sheets). The finger really drags the active card out while its neighbour
 * chases in behind it: every card is positioned at `(--rel + --drag) * 100%`, so
 * the prev/next cards wait one width off either edge and slide in live. On
 * release a flick or a >threshold drag commits to the next/prev index and the
 * `transform` transition finishes the page-turn from wherever the finger left
 * off; a short drag snaps back.
 *
 * Vertical is left to the page: the stack uses `touch-action: pan-y`, and this
 * only claims (preventDefault) a gesture once it reads as horizontal. The axis
 * lock is biased toward horizontal - vertical wins only when it clearly
 * dominates (1.6×) - so a near-horizontal swipe is never stolen by page scroll.
 *
 * Listeners are attached natively (touchmove non-passive) because React's
 * synthetic touch handlers are passive and can't preventDefault.
 */
export function useLayerSwipe({
  ref,
  count,
  index,
  setIndex,
  enabled,
}: {
  ref: {current: HTMLElement | null};
  count: number;
  index: number;
  setIndex: (updater: (i: number) => number) => void;
  enabled: boolean;
}): LayerSwipe {
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Read the live index inside the listeners without re-subscribing each step.
  const idxRef = useRef(index);
  idxRef.current = index;

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || count < 2) return;

    // g holds the in-flight gesture; null between touches.
    let g:
      | {x: number; y: number; t: number; axis: null | 'h' | 'v'; w: number; dx: number}
      | null = null;
    // Coalesce per-move state updates to one per frame so a fast drag can't
    // outrun React with a setState burst.
    let raf = 0;
    let pending = 0;
    const flush = () => {
      raf = 0;
      setDrag(pending);
    };
    const queue = (v: number) => {
      pending = v;
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      g = {x: t.clientX, y: t.clientY, t: e.timeStamp, axis: null, w: el.clientWidth || 1, dx: 0};
    };
    const onMove = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      g.dx = dx;
      if (g.axis === null) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // wait for clear intent
        // Bias toward horizontal: only yield to vertical when it clearly wins.
        g.axis = Math.abs(dy) > Math.abs(dx) * 1.6 ? 'v' : 'h';
        if (g.axis === 'h') setDragging(true);
      }
      if (g.axis !== 'h') return; // vertical → native page scroll (pan-y)
      e.preventDefault(); // own the horizontal drag
      let frac = dx / g.w;
      // Rubber-band when there's no layer to reveal past either end.
      if ((frac > 0 && idxRef.current <= 0) || (frac < 0 && idxRef.current >= count - 1)) {
        frac *= 0.3;
      }
      queue(Math.max(-1, Math.min(1, frac)));
    };
    const onEnd = (e: TouchEvent) => {
      if (!g) return;
      const {axis, dx, t, w} = g;
      g = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (axis !== 'h') return;
      // Commit on a far-enough drag OR a quick flick; otherwise snap back. Both
      // the index change and the drag reset land in one batched render, so the
      // transform transition finishes the page-turn from the finger's last spot.
      const frac = dx / w;
      const dt = e.timeStamp - t;
      const flick = Math.abs(dx) > 24 && dt > 0 && Math.abs(dx) / dt > 0.45;
      setDragging(false);
      setDrag(0);
      if (frac <= -0.22 || (flick && dx < 0)) setIndex((i) => Math.min(count - 1, i + 1));
      else if (frac >= 0.22 || (flick && dx > 0)) setIndex((i) => Math.max(0, i - 1));
    };

    el.addEventListener('touchstart', onStart, {passive: true});
    el.addEventListener('touchmove', onMove, {passive: false});
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, count, ref, setIndex]);

  return {drag, dragging};
}
