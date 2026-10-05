// Automatic render resolution (owner: shell). Pure logic, no DOM: main.js feeds it one sample per frame and applies the
// pixel ratio it returns with scene.setPixelCap.
//
// The splat render is fill-rate bound: its GPU time grows with the number of pixels, that is with the square of the
// pixel ratio (render pixels per CSS pixel). The governor keeps the frame inside the 60 fps budget (16.7 ms):
// - Every `window` frames it looks at the mean frame time (rAF delta) and, where the browser reports it, the mean GPU
//   time of the frame (WebGPU timestamp queries, WebGL EXT_disjoint_timer_query).
// - Down: when frames are late (mean delta above 18.5 ms, below about 54 fps) or the GPU uses more than 90 % of the
//   budget, the ratio drops to the step whose predicted GPU time (time x (new / old)^2) is at most 75 % of the
//   budget, at least one step.
// - Up: only with GPU timing (without it a fast frame says nothing about headroom at 60 Hz). When the next step up is
//   predicted below 65 % of the budget for upWindows windows in a row, and frames are on time, it goes one step up.
//   A step back up to the ratio it last dropped from waits holdMs after the drop and needs twice the windows. The gap between 90 %
//   (down) and 65 % predicted (up) is the hysteresis that stops it from oscillating.
// - Frames over 100 ms (tab switch, a stall) are ignored; settle frames after each change are skipped.
export const QUALITY_DEFAULTS = {
  budgetMs: 1000 / 60,
  lateMs: 18.5,
  downGpu: 0.9,
  targetGpu: 0.75,
  upGpu: 0.65,
  window: 30,
  upWindows: 3,
  settle: 15,
  holdMs: 10000,
  steps: [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2]
};

// opts: { min, max, start } pixel ratios (already limited to the device pixel ratio by the caller), now() for tests.
export function createQualityGovernor(opts, cfg = QUALITY_DEFAULTS) {
  const c = { ...QUALITY_DEFAULTS, ...cfg };
  const steps = c.steps.filter((s) => s >= opts.min - 1e-9 && s <= opts.max + 1e-9);
  if (!steps.length || steps[steps.length - 1] < opts.max - 1e-9) steps.push(opts.max);
  if (steps[0] > opts.min + 1e-9) steps.unshift(opts.min);
  const nearest = (r) => steps.reduce((b, s, i) => (Math.abs(s - r) < Math.abs(steps[b] - r) ? i : b), 0);
  const now = opts.now || (() => performance.now());
  let level = nearest(opts.start);
  let skip = c.settle;
  let n = 0, sumDt = 0, sumGpu = 0, nGpu = 0;
  let upStreak = 0;
  let lastDown = { level: -1, at: -Infinity };
  let slowAtMin = 0, easyAtMax = 0;  // windows in a row: late at the lowest ratio / GPU under 45 % at the highest
  const history = [];

  function change(to, reason, at) {
    if (to === level) return null;
    if (to < level) lastDown = { level, at };
    history.push({ from: steps[level], to: steps[to], reason, at: Math.round(at) });
    if (history.length > 20) history.shift();
    level = to;
    skip = c.settle;
    upStreak = 0;
    return steps[level];
  }

  // dt in ms (rAF delta), gpuMs the GPU time of a recent frame or undefined. Returns a new pixel ratio, or null.
  function sample(dt, gpuMs) {
    if (!(dt > 0) || dt > 100) return null;
    if (skip > 0) { skip--; return null; }
    n++; sumDt += dt;
    if (Number.isFinite(gpuMs) && gpuMs > 0) { sumGpu += gpuMs; nGpu++; }
    if (n < c.window) return null;
    const meanDt = sumDt / n;
    const gpu = nGpu >= n / 2 ? sumGpu / nGpu : null;
    n = 0; sumDt = 0; sumGpu = 0; nGpu = 0;
    const at = now();
    const B = c.budgetMs;
    const r = steps[level];
    const late = meanDt > c.lateMs || (gpu !== null && gpu > c.downGpu * B);
    slowAtMin = level === 0 && late ? slowAtMin + 1 : 0;
    easyAtMax = level === steps.length - 1 && gpu !== null && gpu < 0.45 * B && !late ? easyAtMax + 1 : 0;
    if (late && level > 0) {
      let to = level - 1;
      if (gpu !== null) while (to > 0 && gpu * (steps[to] / r) ** 2 > c.targetGpu * B) to--;
      return change(to, gpu !== null ? 'gpu ' + gpu.toFixed(1) : 'late ' + meanDt.toFixed(1), at);
    }
    if (gpu === null || level >= steps.length - 1 || meanDt > c.lateMs) { upStreak = 0; return null; }
    const predicted = gpu * (steps[level + 1] / r) ** 2;
    if (predicted >= c.upGpu * B) { upStreak = 0; return null; }
    upStreak++;
    const backUp = lastDown.level === level + 1; // back up to the ratio it last dropped from
    if (backUp && at - lastDown.at < c.holdMs) return null;
    if (upStreak < (backUp ? 2 * c.upWindows : c.upWindows)) return null;
    return change(level + 1, 'gpu ' + gpu.toFixed(1), at);
  }

  return {
    sample,
    get ratio() { return steps[level]; },
    get steps() { return steps.slice(); },
    get history() { return history.slice(); },
    // windows in a row with late frames at the lowest ratio: the scene itself is too heavy for this device
    get slowAtMin() { return slowAtMin; },
    // windows in a row with the GPU under 45 % of the budget at the highest ratio: room for more detail
    get easyAtMax() { return easyAtMax; }
  };
}
