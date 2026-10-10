import {useId, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent, PointerEvent} from 'react';
import type {AxisSpec, Figure, Point, Series} from '~/lib/testing-content';
import {useMediaQuery} from '~/lib/use-media-query';
import {
  fmt,
  nearestIndex,
  niceDomain,
  niceTicks,
  project,
  unitLabel,
  type Scale,
} from './chart-math';

/**
 * Measured data as a plain SVG chart. No chart library: the figures are small
 * (at most 400 points a series) and the whole behaviour is a scale, a path and
 * a hover rule. Colours are site tokens, so dark and light need no extra code.
 */

const SERIES_COLOR = [
  'var(--color-gold)',
  'var(--color-text-muted)',
  'var(--color-green)',
  'var(--color-text)',
];

type Geo = {w: number; h: number; l: number; r: number; t: number; b: number};

const Y2_COLOR = 'var(--color-green)';

function seriesColor(i: number): string {
  return SERIES_COLOR[i % SERIES_COLOR.length]!;
}

/** Keep the first and last x labels inside the viewBox. */
function colorFor(s: Series, i: number, hasY2: boolean): string {
  return hasY2 && s.axis === 'y2' ? Y2_COLOR : seriesColor(i);
}

function tickAnchor(px: number, geo: Geo): 'start' | 'middle' | 'end' {
  if (px < geo.l + 10) return 'start';
  if (px > geo.w - geo.r - 10) return 'end';
  return 'middle';
}

function extent(pts: Point[], k: 0 | 1, into: [number, number]) {
  for (const p of pts) {
    if (p[k] < into[0]) into[0] = p[k];
    if (p[k] > into[1]) into[1] = p[k];
  }
}

function seriesPoints(s: Series): Point[][] {
  const all = [s.points];
  if (s.band) all.push(s.band.lo, s.band.hi);
  return all;
}

function domain(
  spec: AxisSpec,
  series: Series[],
  k: 0 | 1,
  target: number,
  zeroBase: boolean,
): [number, number] {
  const ext: [number, number] = [Infinity, -Infinity];
  for (const s of series)
    for (const pts of seriesPoints(s)) extent(pts, k, ext);
  if (!Number.isFinite(ext[0])) return [0, 1];
  if (spec.scale === 'log') {
    return [spec.min ?? Math.max(ext[0], 1e-6), spec.max ?? ext[1]];
  }
  // Magnitudes start at zero unless the figure says otherwise; time and
  // distance axes follow the data.
  let lo = spec.min ?? (zeroBase && ext[0] > 0 ? 0 : ext[0]);
  let hi = spec.max ?? ext[1];
  if (spec.min == null || spec.max == null) {
    const [nlo, nhi] = niceDomain(lo, hi, target);
    if (spec.min == null) lo = nlo;
    if (spec.max == null) hi = nhi;
  }
  return [lo, hi];
}

function pathOf(pts: Point[], sx: Scale, sy: Scale): string {
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    d += `${i === 0 ? 'M' : 'L'}${project(sx, p[0]).toFixed(1)},${project(sy, p[1]).toFixed(1)}`;
  }
  return d;
}

function bandPath(lo: Point[], hi: Point[], sx: Scale, sy: Scale): string {
  if (lo.length === 0 || hi.length === 0) return '';
  const f = (p: Point) =>
    `${project(sx, p[0]).toFixed(1)},${project(sy, p[1]).toFixed(1)}`;
  return `M${lo.map(f).join('L')}L${[...hi].reverse().map(f).join('L')}Z`;
}

function axisTitle(a: AxisSpec): string {
  const u = unitLabel(a.unit);
  return u ? `${a.label} (${u})` : a.label;
}

export function TestChart({
  figure,
  height,
  compact,
  cursor: sharedCursor,
  onCursor,
}: {
  figure: Figure;
  height?: number;
  compact?: boolean;
  /** Controlled hover position (an x value), so a group of charts can share one rule. */
  cursor?: number | null;
  onCursor?: (x: number | null) => void;
}) {
  const uid = useId();
  const narrow = useMediaQuery('(max-width: 639px)');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ownCursor, setOwnCursor] = useState<number | null>(null);
  const controlled = onCursor != null;
  const cursor = controlled ? (sharedCursor ?? null) : ownCursor;
  const setCursor = (x: number | null) => {
    if (controlled) onCursor(x);
    else setOwnCursor(x);
  };
  const [touch, setTouch] = useState(false);

  const hasY2 =
    Boolean(figure.y2) && figure.series.some((s) => s.axis === 'y2');
  // With two y axes the right-axis series gets its own colour and the axis
  // labels take the colour of their series, so each line reads against one scale.
  const colorOf = (s: Series, i: number): string => colorFor(s, i, hasY2);
  const leftColor = hasY2
    ? seriesColor(figure.series.findIndex((s) => s.axis !== 'y2'))
    : undefined;

  const model = useMemo(() => {
    // On a phone the viewBox is about the rendered width, so 11 px labels
    // stay near 11 px instead of shrinking with the scale.
    const w = narrow ? 360 : 720;
    const h = height ?? (narrow ? 300 : compact ? 300 : 400);
    const geo: Geo = {
      w,
      h,
      l: narrow ? 44 : 58,
      r: hasY2 ? (narrow ? 44 : 58) : narrow ? 20 : 14,
      t: 12,
      b: narrow ? 44 : 48,
    };
    const left = figure.series.filter((s) => s.axis !== 'y2');
    const right = figure.series.filter((s) => s.axis === 'y2');
    const xTarget = narrow || compact ? 4 : 6;
    const yTarget = compact ? 4 : 5;
    const xd = domain(figure.x, figure.series, 0, xTarget, false);
    const yd = domain(
      figure.y,
      left.length ? left : figure.series,
      1,
      yTarget,
      true,
    );
    const sx: Scale = {
      kind: figure.x.scale,
      d0: xd[0],
      d1: xd[1],
      r0: geo.l,
      r1: w - geo.r,
    };
    const sy: Scale = {
      kind: figure.y.scale,
      d0: yd[0],
      d1: yd[1],
      r0: h - geo.b,
      r1: geo.t,
    };
    let sy2: Scale | null = null;
    if (hasY2 && figure.y2) {
      const d2 = domain(figure.y2, right, 1, yTarget, true);
      sy2 = {
        kind: figure.y2.scale,
        d0: d2[0],
        d1: d2[1],
        r0: h - geo.b,
        r1: geo.t,
      };
    }
    const xTicks = niceTicks(xd[0], xd[1], xTarget, figure.x.scale);
    const yTicks = niceTicks(yd[0], yd[1], yTarget, figure.y.scale);
    const y2Ticks = sy2 ? niceTicks(sy2.d0, sy2.d1, yTarget, sy2.kind) : [];
    // Sorted union of every x, for hover and arrow keys.
    const xs = [
      ...new Set(figure.series.flatMap((s) => s.points.map((p) => p[0]))),
    ].sort((a, b) => a - b);
    return {geo, sx, sy, sy2, xTicks, yTicks, y2Ticks, xs};
  }, [figure, height, compact, narrow, hasY2]);

  const {geo, sx, sy, sy2, xTicks, yTicks, y2Ticks, xs} = model;
  const clipId = `${uid}-clip`;

  const readout = useMemo(() => {
    if (cursor == null || xs.length === 0) return null;
    const rows = figure.series.map((s, i) => {
      const k = nearestIndex(
        s.points.map((p) => p[0]),
        cursor,
      );
      const p = s.points[k];
      const axis = s.axis === 'y2' && figure.y2 ? figure.y2 : figure.y;
      return {
        id: s.id,
        name: s.name,
        color: colorFor(s, i, hasY2),
        x: p ? p[0] : null,
        text: p ? `${fmt(p[1])} ${unitLabel(axis.unit)}`.trim() : '',
      };
    });
    // Mean height of the traces at the cursor, to park the card on the empty half.
    let sum = 0;
    let n = 0;
    figure.series.forEach((s) => {
      const k = nearestIndex(
        s.points.map((p) => p[0]),
        cursor,
      );
      const p = s.points[k];
      if (!p) return;
      const scale = s.axis === 'y2' && sy2 ? sy2 : sy;
      sum += (scale.r0 - project(scale, p[1])) / (scale.r0 - scale.r1);
      n += 1;
    });
    const showAt = rows.some((r) => r.x != null && r.x !== cursor);
    return {
      x: cursor,
      rows,
      showAt,
      valign: n > 0 && sum / n > 0.5 ? 'bottom' : 'top',
    };
  }, [cursor, figure, xs, sy, sy2, hasY2]);

  const setFromPointer = (e: PointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * geo.w;
    const t = (px - sx.r0) / (sx.r1 - sx.r0);
    const v =
      sx.kind === 'log'
        ? Math.pow(
            10,
            Math.log10(sx.d0) + t * (Math.log10(sx.d1) - Math.log10(sx.d0)),
          )
        : sx.d0 + t * (sx.d1 - sx.d0);
    const i = nearestIndex(xs, v);
    if (i >= 0) setCursor(xs[i]!);
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (xs.length === 0) return;
    const cur = cursor == null ? -1 : nearestIndex(xs, cursor);
    let next = cur;
    if (e.key === 'ArrowRight') next = Math.min(xs.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = cur < 0 ? 0 : Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = xs.length - 1;
    else if (e.key === 'Escape') {
      setCursor(null);
      return;
    } else return;
    e.preventDefault();
    setCursor(xs[next]!);
  };

  const label = `${figure.title}. ${figure.finding}`;
  const cx = readout ? project(sx, readout.x) : 0;
  const cardLeftPct = (cx / geo.w) * 100;
  const cardRight = cardLeftPct > 55;

  return (
    <div
      className="testing-chart"
      ref={wrapRef}
      data-compact={compact ? '' : undefined}
    >
      <div className="testing-plot">
        <svg
          className="testing-chart-svg"
          viewBox={`0 0 ${geo.w} ${geo.h}`}
          role="img"
          aria-label={label}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setCursor(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={geo.l}
                y={geo.t}
                width={geo.w - geo.l - geo.r}
                height={geo.h - geo.t - geo.b}
              />
            </clipPath>
          </defs>

          <g className="testing-grid" aria-hidden="true">
            {yTicks.map((v) => (
              <line
                key={`gy${v}`}
                x1={geo.l}
                x2={geo.w - geo.r}
                y1={project(sy, v)}
                y2={project(sy, v)}
              />
            ))}
            {xTicks.map((v) => (
              <line
                key={`gx${v}`}
                className="testing-grid-x"
                x1={project(sx, v)}
                x2={project(sx, v)}
                y1={geo.t}
                y2={geo.h - geo.b}
              />
            ))}
          </g>

          <g className="testing-axis" aria-hidden="true">
            <line
              x1={geo.l}
              x2={geo.w - geo.r}
              y1={geo.h - geo.b}
              y2={geo.h - geo.b}
            />
            {xTicks.map((v) => (
              <text
                key={`tx${v}`}
                x={project(sx, v)}
                y={geo.h - geo.b + 16}
                textAnchor={tickAnchor(project(sx, v), geo)}
              >
                {fmt(v)}
              </text>
            ))}
            {yTicks.map((v) => (
              <text
                key={`ty${v}`}
                x={geo.l - 7}
                y={project(sy, v) + 3.5}
                textAnchor="end"
                style={leftColor ? {fill: leftColor} : undefined}
              >
                {fmt(v)}
              </text>
            ))}
            {sy2
              ? y2Ticks.map((v) => (
                  <text
                    key={`ty2${v}`}
                    x={geo.w - geo.r + 7}
                    y={project(sy2, v) + 3.5}
                    textAnchor="start"
                    style={{fill: Y2_COLOR}}
                  >
                    {fmt(v)}
                  </text>
                ))
              : null}
            <text
              className="testing-axis-title"
              x={(geo.l + geo.w - geo.r) / 2}
              y={geo.h - 6}
              textAnchor="middle"
            >
              {axisTitle(figure.x)}
            </text>
            <text
              className="testing-axis-title"
              transform={`translate(12 ${(geo.t + geo.h - geo.b) / 2}) rotate(-90)`}
              textAnchor="middle"
              style={leftColor ? {fill: leftColor} : undefined}
            >
              {axisTitle(figure.y)}
            </text>
            {sy2 && figure.y2 ? (
              <text
                className="testing-axis-title"
                transform={`translate(${geo.w - 10} ${(geo.t + geo.h - geo.b) / 2}) rotate(90)`}
                textAnchor="middle"
                style={{fill: Y2_COLOR}}
              >
                {axisTitle(figure.y2)}
              </text>
            ) : null}
          </g>

          <g clipPath={`url(#${clipId})`}>
            {figure.series.map((s, i) => {
              const scaleY = s.axis === 'y2' && sy2 ? sy2 : sy;
              const color = colorOf(s, i);
              return (
                <g key={s.id} className="testing-series" style={{color}}>
                  {s.band ? (
                    <path
                      className="testing-band"
                      d={bandPath(s.band.lo, s.band.hi, sx, scaleY)}
                    />
                  ) : null}
                  {s.style === 'points' ? (
                    s.points.map((p, k) => (
                      <circle
                        key={`${s.id}-${p[0]}`}
                        cx={project(sx, p[0])}
                        cy={project(scaleY, p[1])}
                        r={2.5}
                        fill={color}
                      />
                    ))
                  ) : (
                    <path
                      className="testing-line"
                      d={pathOf(s.points, sx, scaleY)}
                      stroke={color}
                      strokeDasharray={s.style === 'dashed' ? '6 4' : undefined}
                    />
                  )}
                  {s.style !== 'points' && s.points.length <= 24
                    ? s.points.map((p, k) => (
                        <circle
                          key={`${s.id}-${p[0]}`}
                          cx={project(sx, p[0])}
                          cy={project(scaleY, p[1])}
                          r={2.8}
                          fill={color}
                        />
                      ))
                    : null}
                </g>
              );
            })}
          </g>

          {readout ? (
            <g aria-hidden="true">
              <line
                className="testing-rule"
                x1={cx}
                x2={cx}
                y1={geo.t}
                y2={geo.h - geo.b}
              />
              {figure.series.map((s, i) => {
                const k = nearestIndex(
                  s.points.map((p) => p[0]),
                  readout.x,
                );
                const p = s.points[k];
                if (!p) return null;
                const scaleY = s.axis === 'y2' && sy2 ? sy2 : sy;
                return (
                  <circle
                    key={s.id}
                    cx={project(sx, p[0])}
                    cy={project(scaleY, p[1])}
                    r={4}
                    fill="var(--color-bg)"
                    stroke={colorOf(s, i)}
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          ) : null}

          <rect
            className="testing-hit"
            x={geo.l}
            y={geo.t}
            width={geo.w - geo.l - geo.r}
            height={geo.h - geo.t - geo.b}
            fill="transparent"
            onPointerDown={(e) => {
              setTouch(e.pointerType === 'touch');
              setFromPointer(e);
            }}
            onPointerMove={(e) => {
              setTouch(e.pointerType === 'touch');
              setFromPointer(e);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType !== 'touch') setCursor(null);
            }}
          />
        </svg>

        {readout ? (
          <div
            className="testing-readout"
            data-pinned={touch ? '' : undefined}
            data-side={cardRight ? 'left' : 'right'}
            data-valign={readout.valign}
            style={touch ? undefined : {left: `${cardLeftPct}%`}}
            aria-hidden="true"
          >
            <div className="testing-readout-x">
              {figure.x.label} {fmt(readout.x)} {unitLabel(figure.x.unit)}
            </div>
            {readout.rows.map((r) => (
              <div key={r.id} className="testing-readout-row">
                <span
                  className="testing-swatch"
                  style={{background: r.color}}
                />
                <span className="testing-readout-name">{r.name}</span>
                <span className="testing-readout-val">
                  {r.text}
                  {readout.showAt && r.x != null ? (
                    <span className="testing-readout-at">
                      at {fmt(r.x)} {unitLabel(figure.x.unit)}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <p className="sr-only" aria-live="polite">
        {readout
          ? `${figure.x.label} ${fmt(readout.x)} ${unitLabel(figure.x.unit)}. ${readout.rows
              .map((r) => `${r.name} ${r.text}`)
              .join('. ')}`
          : ''}
      </p>

      <ul className="testing-legend">
        {figure.series.map((s, i) => (
          <li key={s.id}>
            <svg width="22" height="8" aria-hidden="true">
              <line
                x1="0"
                x2="22"
                y1="4"
                y2="4"
                stroke={colorOf(s, i)}
                strokeWidth="2"
                strokeDasharray={s.style === 'dashed' ? '5 3' : undefined}
              />
            </svg>
            <span>
              {s.axis === 'y2' && hasY2 ? `${s.name} (right axis)` : s.name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
