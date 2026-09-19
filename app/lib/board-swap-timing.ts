// Single source of truth for the PDP teardown variant-swap timing. Both the CSS
// (pushed as custom properties onto the .board-art root) and the JS settle
// backstop read THESE numbers, so a duration change is a one-line edit here with
// no magic numbers drifting out of sync. See BoardArt.tsx (the swap reducer) and
// app.css (the @media swap block that consumes --swap-dur/--swap-stagger/--swap-exit).
//
// The swap is TWO sequential phases: the old board flies OUT (exitS + stagger),
// then the new board flies IN (durS + stagger) - the incoming is delayed by the
// outgoing's full flight (--swap-in-delay) so the two never overlap.
export const SWAP_TIMING = {
  /** Incoming layer fly-in duration (seconds). */
  durS: 0.45,
  /** Per-layer --depth stagger (seconds) - shared by the in + out animations. */
  staggerS: 0.06,
  /** Outgoing layer fly-out (shove) duration (seconds). */
  exitS: 0.45,
} as const;

/**
 * When the LAST (deepest) outgoing layer's fly-out ends (seconds) - i.e. how long
 * the whole OUT phase takes, which is exactly the delay the IN phase waits so the
 * old board is gone before the new one arrives. `layers` = outgoing layer count
 * (1 for the mobile whole-board slide).
 */
export function swapInDelayS(layers: number): number {
  return Math.max(0, layers - 1) * SWAP_TIMING.staggerS + SWAP_TIMING.exitS;
}

/**
 * Backstop deadline (ms) for a swap whose old board has `outLayers` and new board
 * has `inLayers`: the moment the LAST incoming layer lands (out phase + in phase),
 * plus a cushion. The swap settles on real board-swap-in `animationend` counting;
 * this is only a safety net for a dropped event (e.g. a backgrounded tab) so the
 * swap can never hang.
 */
export function swapSettleBackstopMs(outLayers: number, inLayers: number): number {
  const lastInLandS =
    swapInDelayS(outLayers) +
    Math.max(0, inLayers - 1) * SWAP_TIMING.staggerS +
    SWAP_TIMING.durS;
  return Math.round(lastInLandS * 1000) + 350;
}

// Layer sweep: the walk BoardArt does when the active layer changes by more than
// one, so a top-to-bottom flip shows what is in between rather than cutting
// straight there. Separate from SWAP_TIMING above, which is the variant swap.
export const LAYER_SWEEP = {
  /**
   * Time budget per step (ms). The total is steps × this, so the sweep scales
   * with distance: a full 8-layer traverse runs ~530ms, a three-layer hop ~230ms.
   */
  perStepMs: 76,
  /**
   * Ease-out exponent. 3 (cubic) is a hard launch and a long settle, 2 is
   * gentler, 1 is a flat interval. Raising it makes the first layers pass
   * faster still.
   */
  ease: 3,
} as const;

/**
 * Per-step delays (ms) for a sweep of `steps` layers, in order.
 *
 * Step k is placed at the INVERSE of an ease-out: position over time is eased,
 * so solving it for time gives the delays. The first few layers go by in a few
 * frames and the last takes roughly half the sweep, which reads as the stack
 * being thrown open and settling rather than a mechanical flick-through.
 *
 * Delays sum to exactly `steps × perStepMs` (floating point aside), so easing
 * only redistributes the budget, it never changes the total.
 */
export function layerSweepDelays(steps: number): number[] {
  if (!(steps > 0)) return [];
  const total = steps * LAYER_SWEEP.perStepMs;
  const landAt = (k: number) =>
    total * (1 - Math.pow(1 - k / steps, 1 / LAYER_SWEEP.ease));
  const out: number[] = [];
  let prev = 0;
  for (let k = 1; k <= steps; k++) {
    const at = landAt(k);
    out.push(Math.max(0, at - prev));
    prev = at;
  }
  return out;
}
