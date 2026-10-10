import {useEffect, useRef} from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import {assignStyles, CANVAS, INK, MUTED, SURFACE, type Theme} from '~/lib/testing/palette';
import {markerPath} from '~/lib/testing/geometry';
import {
  alignSeries,
  figureDomains,
  fmtTick,
  fullXDomain,
  nearestSorted,
  niceTicks,
  tickStep,
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
export type ReadoutState = {x: number; rows: ReadoutRow[]} | null;
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
};

const hexA = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export function Chart({fig, theme, hidden, height, initialRange, onReadout, onRange, onReady}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const cb = useRef({onReadout, onRange});
  cb.current = {onReadout, onRange};
  const initial = useRef(initialRange);
  const applyYRef = useRef<((u: uPlot) => void) | null>(null);

  // Build the plot. Rebuilt only when the figure, the theme or the height change.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const font = getComputedStyle(el).fontFamily || 'sans-serif';
    const styles = assignStyles(fig.series, theme);
    const aligned = alignSeries(fig.series);
    const full = fullXDomain(fig);
    const grid = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
    const hasY2 = Boolean(fig.axes.y2);
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
      u.batch(() => {
        u.setScale('y', {min: d.y[0], max: d.y[1]});
        if (d.y2) u.setScale('y2', {min: d.y2[0], max: d.y2[1]});
      });
    };
    applyYRef.current = applyY;
    const count = (u: uPlot, axisPx: number) => Math.max(3, Math.floor(axisPx / 90));
    const xSplits = (u: uPlot, _a: number, min: number, max: number) =>
      niceTicks(min, max, count(u, u.bbox.width / devicePixelRatio));
    const ySplits = (u: uPlot, _a: number, min: number, max: number) =>
      niceTicks(min, max, Math.max(3, Math.floor(u.bbox.height / devicePixelRatio / 48)));
    const fmtAxis = (_u: uPlot, splits: number[]) => {
      const step = tickStep(splits);
      return splits.map((v) => fmtTick(v, step));
    };
    const axisBase = {
      stroke: MUTED[theme],
      font: `12px ${font}`,
      labelFont: `14px ${font}`,
      ticks: {stroke: grid, width: 1, size: 4},
      grid: {stroke: grid, width: 1},
      values: fmtAxis,
    };
    const narrow = el.clientWidth < 520;
    const lab = (a: {label: string; unit: string}) =>
      `${narrow ? a.label.replace(/\s*\(.*?\)/g, '') : a.label} (${a.unit})`;

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
        return {
          ...base,
          stroke: hexA(st.color, st.opacity),
          width: st.width,
          dash: st.dash.length ? st.dash : undefined,
          points: {
            show: s.x.length <= 24,
            size: 7,
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
      ctx.save();
      ctx.beginPath();
      const slack = 10 * pr;
      ctx.rect(u.bbox.left - 2 * pr, u.bbox.top - 6 * pr, u.bbox.width + slack, u.bbox.height + 6 * pr);
      ctx.clip();
      fig.series.forEach((s, k) => {
        if (s.kind !== 'hold' || hiddenRef.current.has(s.id)) return;
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
            let y0 = u.valToPos(hi, scale, true);
            let y1 = u.valToPos(lo, scale, true);
            const pad = Math.max(0, 4 * pr - Math.abs(y1 - y0) / 2);
            y0 -= pad;
            y1 += pad;
            ctx.strokeStyle = hexA(st.color, 0.35);
            ctx.lineWidth = 6 * pr;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(cx, y0);
            ctx.lineTo(cx, y1);
            ctx.stroke();
          }
          ctx.fillStyle = st.color;
          ctx.strokeStyle = SURFACE[theme];
          ctx.lineWidth = 1.5 * pr;
          ctx.stroke(new Path2D(markerPath(st.marker, cx, cy, 4.5 * pr)));
          ctx.fill(new Path2D(markerPath(st.marker, cx, cy, 4.5 * pr)));
        }
        void k;
      });
      ctx.restore();
      drawCallout(u);
    };

    const drawCallout = (u: uPlot) => {
      const cx = fig.callout_x;
      if (cx === undefined) return;
      const s = fig.series.find((q) => !hiddenRef.current.has(q.id));
      if (!s) return;
      const i = nearestSorted(s, cx);
      if (i < 0) return;
      const ctx = u.ctx;
      const pr = devicePixelRatio;
      const px = u.valToPos(s.x[i]!, 'x', true);
      const py = u.valToPos(s.y[i]!, s.axis === 'y2' ? 'y2' : 'y', true);
      const st = styles[s.id]!;
      const maxW = Math.min(260 * pr, u.bbox.width * 0.6);
      ctx.save();
      ctx.font = `${12 * pr}px ${font}`;
      const words = fig.finding.split(' ');
      const lines: string[] = [];
      let cur = '';
      for (const w of words) {
        const t = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(t).width > maxW - 16 * pr && cur) {
          lines.push(cur);
          cur = w;
        } else cur = t;
      }
      if (cur) lines.push(cur);
      const lh = 16 * pr;
      const bw = maxW;
      const bh = lines.length * lh + 12 * pr;
      let bx = px + 24 * pr;
      if (bx + bw > u.bbox.left + u.bbox.width) bx = px - 24 * pr - bw;
      bx = Math.max(u.bbox.left + 4 * pr, bx);
      let by = py - bh - 24 * pr;
      if (by < u.bbox.top + 4 * pr) by = py + 24 * pr;
      ctx.strokeStyle = MUTED[theme];
      ctx.lineWidth = 1 * pr;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(bx < px ? bx + bw : bx, by + bh / 2);
      ctx.stroke();
      ctx.fillStyle = SURFACE[theme];
      ctx.strokeStyle = hexA(INK[theme], 0.25);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = st.color;
      ctx.fillRect(bx, by, 4 * pr, bh);
      ctx.fillStyle = INK[theme];
      ctx.textBaseline = 'top';
      lines.forEach((t, n) => ctx.fillText(t, bx + 12 * pr, by + 6 * pr + n * lh));
      ctx.restore();
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
            label: `${s.pack ?? s.label}${s.kind === 'hold' ? ' hold' : ''}`,
            color: styles[s.id]!.color,
            unit: (s.axis === 'y2' ? fig.axes.y2 : fig.axes.y)?.unit ?? '',
            x: s.x[i]!,
            y: s.y[i]!,
            kind: s.kind,
          });
        }
        cb.current.onReadout({x, rows});
      });
    };

    const resetRange = (u: uPlot) => u.setScale('x', {min: full[0], max: full[1]});

    const opts: uPlot.Options = {
      width: Math.max(200, el.clientWidth),
      height,
      padding: [10, hasY2 ? 6 : 14, 0, 0],
      legend: {show: false},
      cursor: {
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
        {...axisBase, scale: 'x', size: 36, label: lab(fig.axes.x), labelSize: 22, splits: xSplits, gap: 4},
        {...axisBase, scale: 'y', size: 62, label: lab(fig.axes.y), labelSize: 22, splits: ySplits, gap: 4},
        ...(hasY2
          ? [
              {
                ...axisBase,
                scale: 'y2',
                side: 1,
                size: 62,
                label: lab(fig.axes.y2!),
                labelSize: 22,
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

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resetRange(u);
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
  }, [fig, theme, height]);

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
      aria-label={`${fig.title}. Drag to zoom, Escape resets.`}
      data-canvas-bg={CANVAS[theme]}
    />
  );
}
