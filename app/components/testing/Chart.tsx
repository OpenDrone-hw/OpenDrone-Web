import {useEffect, useRef} from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {assignStyles, CANVAS, INK, MUTED, SURFACE, type Theme} from '~/lib/testing/palette';
import {connectsHolds, GUTTER_L, GUTTER_L_NARROW, layoutNotes, MARK_ROW, MARKER_R, markerPath, TICK_PX} from '~/lib/testing/geometry';
import {directPad, plainLabel} from '~/lib/testing/labels';
import {axisTitle} from '~/lib/testing/layout';
import {
  alignSeries,
  evenTicks,
  figureDomains,
  fmtTickSet,
  fmtValue,
  nearestSorted,
  niceTicks,
  type Domain,
} from '~/lib/testing/scale';
import type {Fig} from '~/lib/testing/types';

/**
 * The interactive chart: uPlot on a canvas whose backing store is the CSS size
 * times the device pixel ratio, so lines stay sharp at any density. Domains,
 * ticks and styles come from the same modules as the static SVG.
 *
 * Client only. The server never imports this file: FigureCard loads it
 * (and uPlot) after hydration, when the figure nears the viewport.
 */

export type ReadoutRow = {
  id: string;
  label: string;
  color: string;
  unit: string;
  x: number;
  y: number;
  kind: string;
};
/** `frac` is where the cursor is along the plot, 0 to 1, so the readout can sit on the far side. */
export type ReadoutState = {x: number; rows: ReadoutRow[]; frac: number} | null;
export type RangeState = {x0: number; x1: number; zoomed: boolean};

export type ChartApi = {
  reset: () => void;
};

type Props = {
  fig: Fig;
  theme: Theme;
  hidden: ReadonlySet<string>;
  height: number;
  /** Initial x window, restored from the URL. */
  initialRange?: Domain | null;
  onReadout: (r: ReadoutState) => void;
  onRange: (r: RangeState) => void;
  onReady: (api: ChartApi | null) => void;
  /** Spoken text for a cursor moved with the keyboard. */
  onAnnounce?: (text: string) => void;
  /** Charts with the same key share cursor and zoom window (small multiples). */
  syncKey?: string;
  /** False on the upper panels of a stack: ticks stay, labels and title go. */
  showXLabels?: boolean;
};

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function Chart({fig, theme, hidden, height, initialRange, onReadout, onRange, onReady, onAnnounce, syncKey, showXLabels = true}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const cb = useRef({onReadout, onRange, onAnnounce});
  cb.current = {onReadout, onRange, onAnnounce};
  const initial = useRef(initialRange);
  const applyYRef = useRef<((u: uPlot) => void) | null>(null);

  // Build the plot. Rebuilt only when the figure, the theme or the height change.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const font = getComputedStyle(el).fontFamily || 'sans-serif';
    const styles = assignStyles(fig.series, theme);
    const aligned = alignSeries(fig.series);
    const full = figureDomains(fig, {hidden: hiddenRef.current}).x;
    const grid = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const hasY2 = Boolean(fig.axes.y2);
    let dualN: number | undefined;
    const windowOf = (u: uPlot): Domain | undefined => {
      const a = u.scales.x.min;
      const b = u.scales.x.max;
      if (a === undefined || b === undefined || a === null || b === null) return undefined;
      return a <= full[0] + 1e-9 && b >= full[1] - 1e-9 ? undefined : [a, b];
    };
    // The y ranges follow the visible x window and the shown series. They are
    // set after the x scale commits (hook below), not in a range callback,
    // which runs before the new x is in place.
    const applyY = (u: uPlot) => {
      const d = figureDomains(fig, {hidden: hiddenRef.current, xWindow: windowOf(u)});
      dualN = d.n;
      u.batch(() => {
        u.setScale('y', {min: d.y[0], max: d.y[1]});
        if (d.y2) u.setScale('y2', {min: d.y2[0], max: d.y2[1]});
      });
    };
    applyYRef.current = applyY;
    const count = (u: uPlot, axisPx: number) => Math.max(3, Math.min(8, Math.floor(axisPx / 100)));
    const xSplits = (u: uPlot, _a: number, min: number, max: number) =>
      niceTicks(min, max, count(u, u.bbox.width / devicePixelRatio));
    const ySplits = (u: uPlot, _a: number, min: number, max: number) =>
      dualN && hasY2
        ? evenTicks(min, max, dualN)
        : niceTicks(min, max, Math.min(5, Math.max(3, Math.floor(u.bbox.height / devicePixelRatio / 56))));
    const fmtAxis = (_u: uPlot, splits: number[]) => fmtTickSet(splits);
    const axisBase = {
      stroke: MUTED[theme],
      font: `${TICK_PX}px ${font}`,
      labelFont: `12px ${font}`,
      ticks: {stroke: grid, width: 1, size: 4},
      grid: {stroke: grid, width: 1},
      values: fmtAxis,
    };
    const narrow = el.clientWidth < 520;
    const gutter = narrow ? GUTTER_L_NARROW : GUTTER_L;
    const nLines = Math.min(2, (fig.marks ?? []).filter((q) => q.kind === 'line').length);
    const rightPad = directPad(fig, narrow);

    const series: uPlot.Series[] = [
      {},
      ...fig.series.map((s): uPlot.Series => {
        const st = styles[s.id]!;
        const base: uPlot.Series = {
          label: s.label,
          scale: s.axis === 'y2' ? 'y2' : 'y',
          show: !hiddenRef.current.has(s.id),
          spanGaps: false,
        };
        if (s.kind === 'hold') {
          return {...base, paths: () => null, points: {show: false}};
        }
        if (s.kind === 'frames') {
          // Dots, never a line: rotor speed and thrust are sampled at different
          // rates, so a line through them would draw a sawtooth.
          return {
            ...base,
            paths: () => null,
            points: {show: true, size: 5, width: 0, stroke: hexA(st.color, st.opacity), fill: hexA(st.color, st.opacity)},
          };
        }
        return {
          ...base,
          stroke: hexA(st.color, st.opacity),
          width: st.width,
          dash: st.dash.length ? st.dash : undefined,
          points: {
            show: s.x.length <= 24,
            size: 8,
            width: 1.5,
            stroke: st.color,
            fill: SURFACE[theme],
          },
        };
      }),
    ];

    const drawHolds = (u: uPlot) => {
      const ctx = u.ctx;
      const pr = devicePixelRatio;
      const hiddenNow = hiddenRef.current;
      const plotBox = {
        x0: u.bbox.left / pr,
        y0: u.bbox.top / pr,
        x1: (u.bbox.left + u.bbox.width) / pr,
        y1: (u.bbox.top + u.bbox.height) / pr,
      };
      const win = windowOf(u);
      ctx.save();
      ctx.font = `500 ${12 * pr}px ${font}`;
      const laid = layoutNotes(fig, {
        px: (v) => u.valToPos(v, 'x', true) / pr,
        py: (v, axis) => u.valToPos(v, axis, true) / pr,
        plot: plotBox,
        measure: (t) => ctx.measureText(t).width / pr,
        styles,
        hidden: hiddenNow,
        narrow,
        xWindow: win,
        rightPad,
      });
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      // Markers on the plot edge (100 percent throttle) are drawn whole.
      const m = (MARKER_R + 3) * pr;
      ctx.rect(u.bbox.left - m, u.bbox.top - m, u.bbox.width + 2 * m, u.bbox.height + 2 * m);
      ctx.clip();
      // The fitted law, under the markers, clipped to the plot rectangle.
      if (fig.fit) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();
        const {k, x0, x1} = fig.fit;
        ctx.strokeStyle = hexA(INK[theme], 0.6);
        ctx.lineWidth = 1.25 * pr;
        ctx.setLineDash([5 * pr, 4 * pr]);
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const xv = x0 + ((x1 - x0) * i) / 40;
          const px = u.valToPos(xv, 'x', true);
          const py = u.valToPos(k * (xv / 1000) ** 2, 'y', true);
          if (i) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      // Hold markers are joined by a thin line unless the fitted law draws the trend.
      if (connectsHolds(fig)) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();
        fig.series.forEach((s) => {
          if (s.kind !== 'hold' || hiddenNow.has(s.id)) return;
          const st = styles[s.id]!;
          const scale = s.axis === 'y2' ? 'y2' : 'y';
          ctx.strokeStyle = hexA(st.color, 0.55);
          ctx.lineWidth = st.width * pr;
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < s.x.length; i++) {
            const xv = s.x[i];
            const yv = s.y[i];
            if (xv === null || xv === undefined || yv === null || yv === undefined) {
              pen = false;
              continue;
            }
            const px = u.valToPos(xv, 'x', true);
            const py = u.valToPos(yv, scale, true);
            if (pen) ctx.lineTo(px, py);
            else ctx.moveTo(px, py);
            pen = true;
          }
          ctx.stroke();
        });
        ctx.restore();
      }
      // Hold markers with their interquartile whisker, a surface ring around each.
      fig.series.forEach((s) => {
        if (s.kind !== 'hold' || hiddenNow.has(s.id)) return;
        const st = styles[s.id]!;
        const scale = s.axis === 'y2' ? 'y2' : 'y';
        for (let i = 0; i < s.x.length; i++) {
          const xv = s.x[i];
          const yv = s.y[i];
          if (xv === null || xv === undefined || yv === null || yv === undefined) continue;
          const cx = u.valToPos(xv, 'x', true);
          const cy = u.valToPos(yv, scale, true);
          const lo = s.lo?.[i];
          const hi = s.hi?.[i];
          if (lo !== null && lo !== undefined && hi !== null && hi !== undefined) {
            const y0 = u.valToPos(hi, scale, true);
            const y1 = u.valToPos(lo, scale, true);
            // Whisker with end caps: the 25th to 75th percentile of the hold.
            ctx.strokeStyle = hexA(st.color, 0.9);
            ctx.lineWidth = 1.5 * pr;
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(cx, y0);
            ctx.lineTo(cx, y1);
            ctx.moveTo(cx - 4 * pr, y0);
            ctx.lineTo(cx + 4 * pr, y0);
            ctx.moveTo(cx - 4 * pr, y1);
            ctx.lineTo(cx + 4 * pr, y1);
            ctx.stroke();
          }
          const path = new Path2D(markerPath(st.marker, cx, cy, MARKER_R * pr));
          ctx.fillStyle = st.color;
          ctx.strokeStyle = SURFACE[theme];
          ctx.lineWidth = 2 * pr;
          ctx.lineJoin = 'round';
          ctx.stroke(path);
          ctx.fill(path);
        }
      });
      // Rings on marked points.
      laid.rings.forEach(([x, y, id]) => {
        ctx.strokeStyle = styles[id]?.color ?? INK[theme];
        ctx.lineWidth = 1.5 * pr;
        ctx.beginPath();
        ctx.arc(x * pr, y * pr, (MARKER_R + 4) * pr, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.restore();

      // Vertical mark lines with their label in the strip above the plot.
      ctx.font = `${12 * pr}px ${font}`;
      ctx.textBaseline = 'alphabetic';
      laid.lines.forEach((l) => {
        const text = l.text;
        const w = ctx.measureText(text).width / pr;
        const fits = l.x - 5 - w >= plotBox.x0;
        const y = 13 + l.row * MARK_ROW;
        ctx.save();
        ctx.strokeStyle = MUTED[theme];
        ctx.lineWidth = pr;
        ctx.setLineDash([3 * pr, 3 * pr]);
        ctx.beginPath();
        ctx.moveTo(l.x * pr, (y + 4) * pr);
        ctx.lineTo(l.x * pr, plotBox.y1 * pr);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = INK[theme];
        ctx.textAlign = fits ? 'right' : 'left';
        ctx.fillText(text, (fits ? l.x - 5 : l.x + 5) * pr, y * pr);
      });
      ctx.textAlign = 'left';
      // Written notes: end value, fit, marks, direct labels.
      ctx.font = `500 ${12 * pr}px ${font}`;
      ctx.textBaseline = 'alphabetic';
      laid.notes.forEach((n) => {
        ctx.fillStyle = n.sid ? (styles[n.sid]?.color ?? MUTED[theme]) : MUTED[theme];
        n.lines.forEach((t, k) => ctx.fillText(t, n.left * pr, (n.top + 11 + k * (TICK_PX + 3)) * pr));
      });
    };

    let raf = 0;
    const emitReadout = (u: uPlot) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const left = u.cursor.left;
        if (left === undefined || left < 0) {
          cb.current.onReadout(null);
          return;
        }
        const x = u.posToVal(left, 'x');
        const rows: ReadoutRow[] = [];
        for (const s of fig.series) {
          if (hiddenRef.current.has(s.id)) continue;
          const i = nearestSorted(s, x);
          if (i < 0) continue;
          rows.push({
            id: s.id,
            label: s.pack ?? plainLabel(s.label, s.short),
            color: styles[s.id]!.color,
            unit: (s.axis === 'y2' ? fig.axes.y2 : fig.axes.y)?.unit ?? '',
            x: s.x[i]!,
            y: s.y[i]!,
            kind: s.kind,
          });
        }
        cb.current.onReadout({x, rows, frac: left / Math.max(1, u.bbox.width / devicePixelRatio)});
      });
    };

    const resetRange = (u: uPlot) => u.setScale('x', {min: full[0], max: full[1]});

    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height,
      padding: [12 + nLines * MARK_ROW, (hasY2 ? 4 : 16) + rightPad, 0, 0],
      legend: {show: false},
      cursor: {
        ...(syncKey ? {sync: {key: syncKey, scales: ['x', null] as [string, null], setSeries: false}} : {}),
        drag: {x: true, y: false, setScale: true, dist: 6},
        points: {size: 8, width: 1.5},
        y: false,
        bind: {
          dblclick: (u) => () => {
            resetRange(u);
            return null;
          },
        },
      },
      scales: {
        x: {time: false, auto: false, range: (_u, min, max) => [min, max]},
        y: {auto: false, range: (_u, min, max) => [min, max]},
        ...(hasY2 ? {y2: {auto: false, range: (_u: uPlot, min: number, max: number) => [min, max] as [number, number]}} : {}),
      },
      axes: [
        showXLabels
          ? ({...axisBase, scale: 'x', size: 30, label: axisTitle(fig, 'x'), labelSize: 20, splits: xSplits, gap: 3} as uPlot.Axis)
          : ({...axisBase, scale: 'x', size: 6, splits: xSplits, values: (_u: uPlot, sp: number[]) => sp.map(() => ''), gap: 0} as uPlot.Axis),
        {
          ...axisBase,
          scale: 'y',
          size: gutter,
          splits: ySplits,
          gap: 3,
        },
        ...(hasY2
          ? [
              {
                ...axisBase,
                scale: 'y2',
                side: 1,
                size: gutter,
                splits: ySplits,
                grid: {show: false},
                gap: 4,
              } as uPlot.Axis,
            ]
          : []),
      ],
      series,
      hooks: {
        draw: [drawHolds],
        setCursor: [emitReadout],
        setScale: [
          (u, key) => {
            if (key !== 'x') return;
            const a = u.scales.x.min ?? full[0];
            const b = u.scales.x.max ?? full[1];
            const zoomed = a > full[0] + 1e-9 || b < full[1] - 1e-9;
            applyY(u);
            cb.current.onRange({x0: a, x1: b, zoomed});
          },
        ],
      },
    };

    const data: uPlot.AlignedData = [
      aligned.x,
      ...aligned.ys,
    ] as unknown as uPlot.AlignedData;
    const u = new uPlot(opts, data, el);
    plot.current = u;
    const start = initial.current;
    if (start && start[1] > start[0]) u.setScale('x', {min: start[0], max: start[1]});
    else u.setScale('x', {min: full[0], max: full[1]});
    initial.current = null;

    // Touch: one finger scrubs the readout, two fingers pinch. Vertical drags
    // are left to the page (touch-action: pan-y).
    const over = u.over;
    over.style.touchAction = 'pan-y';
    let pinch: {d: number; x0: number; x1: number} | null = null;
    const touchPos = (t: Touch) => {
      const r = over.getBoundingClientRect();
      return {left: t.clientX - r.left, top: t.clientY - r.top};
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        pinch = {
          d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          x0: u.scales.x.min ?? full[0],
          x1: u.scales.x.max ?? full[1],
        };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinch) {
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
        const mid = u.posToVal(touchPos(a).left / 2 + touchPos(b).left / 2, 'x');
        const k = pinch.d / d;
        let lo = mid - (mid - pinch.x0) * k;
        let hi = mid + (pinch.x1 - mid) * k;
        lo = Math.max(full[0], lo);
        hi = Math.min(full[1], hi);
        if (hi - lo > (full[1] - full[0]) * 0.005) u.setScale('x', {min: lo, max: hi});
        e.preventDefault();
      } else if (e.touches.length === 1) {
        u.setCursor(touchPos(e.touches[0]!));
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) u.setCursor({left: -10, top: -10});
    };
    over.addEventListener('touchstart', onTouchStart, {passive: true});
    over.addEventListener('touchmove', onTouchMove, {passive: false});
    over.addEventListener('touchend', onTouchEnd, {passive: true});
    over.addEventListener('touchcancel', onTouchEnd, {passive: true});

    // Keyboard: arrows step the cursor through the points of the first shown
    // hold series (or the shared x values), +/- zoom, Home/End jump, Escape resets.
    let at = -1;
    const stops = () => {
      const h = fig.series.find((q) => q.kind === 'hold' && !hiddenRef.current.has(q.id));
      const src = h ? (h.x.filter((v) => v !== null) as number[]) : aligned.x;
      if (src.length <= 60) return src;
      const step = Math.ceil(src.length / 60);
      return src.filter((_, i) => i % step === 0);
    };
    const speak = (x: number) => {
      const parts: string[] = [`${fmtValue(x)} ${fig.axes.x.unit}`];
      for (const s of fig.series) {
        if (hiddenRef.current.has(s.id) || s.kind === 'frames') continue;
        const i = nearestSorted(s, x);
        if (i < 0) continue;
        const ax = s.axis === 'y2' ? fig.axes.y2 : fig.axes.y;
        parts.push(`${s.pack ?? s.label} ${fmtValue(s.y[i]!)} ${ax?.unit ?? ''}`.trim());
      }
      cb.current.onAnnounce?.(parts.join(', '));
    };
    const moveTo = (x: number) => {
      const a = u.scales.x.min ?? full[0];
      const b = u.scales.x.max ?? full[1];
      if (x < a || x > b) {
        const w = b - a;
        u.setScale('x', {min: Math.max(full[0], x - w / 2), max: Math.min(full[1], x + w / 2)});
      }
      u.setCursor({left: u.valToPos(x, 'x'), top: u.bbox.height / devicePixelRatio / 2});
      speak(x);
    };
    const onKey = (e: KeyboardEvent) => {
      const xs = stops();
      if (e.key === 'Escape') {
        resetRange(u);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        if (!xs.length) return;
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.key === 'Home') at = 0;
        else if (e.key === 'End') at = xs.length - 1;
        else {
          if (at < 0) {
            const cur = u.cursor.left;
            const x = cur !== undefined && cur >= 0 ? u.posToVal(cur, 'x') : u.scales.x.min ?? full[0];
            at = xs.findIndex((v) => v >= x);
            if (at < 0) at = xs.length - 1;
            else if (dir < 0) at = Math.max(0, at - 1);
          } else at = Math.min(xs.length - 1, Math.max(0, at + dir));
        }
        moveTo(xs[at]!);
        e.preventDefault();
      } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
        const a = u.scales.x.min ?? full[0];
        const b = u.scales.x.max ?? full[1];
        const mid = at >= 0 && xs[at] !== undefined ? xs[at]! : (a + b) / 2;
        const k = e.key === '+' || e.key === '=' ? 0.6 : 1 / 0.6;
        const lo = Math.max(full[0], mid - (mid - a) * k);
        const hi = Math.min(full[1], mid + (b - mid) * k);
        if (hi - lo > (full[1] - full[0]) * 0.005) u.setScale('x', {min: lo, max: hi});
        e.preventDefault();
      }
    };
    el.addEventListener('keydown', onKey);

    const ro = new ResizeObserver(() => {
      const w = Math.max(200, el.clientWidth);
      if (Math.abs(w - u.width) > 1) u.setSize({width: w, height});
    });
    ro.observe(el);

    onReady({reset: () => resetRange(u)});
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('keydown', onKey);
      onReady(null);
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fig, theme, height, syncKey, showXLabels]);

  // Show and hide series without rebuilding.
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    u.batch(() => {
      fig.series.forEach((s, k) => {
        const show = !hidden.has(s.id);
        if (u.series[k + 1]!.show !== show) u.setSeries(k + 1, {show});
      });
    });
    applyYRef.current?.(u);
    u.redraw();
  }, [hidden, fig]);

  return (
    <div
      ref={host}
      className="tw-chart"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions
      tabIndex={0}
      role="application"
      aria-label={`${fig.title}. Left and right arrows read values, plus and minus zoom, Escape resets.`}
      data-canvas-bg={CANVAS[theme]}
    />
  );
}
