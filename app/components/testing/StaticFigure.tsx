import {useId} from 'react';
import {buildGeometry, MARKER_R, markerPath, TICK_PX} from '~/lib/testing/geometry';
import {defaultHidden} from '~/lib/testing/labels';
import {axisTitle} from '~/lib/testing/layout';
import {CANVAS, INK, MUTED, SURFACE, type Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';

/**
 * A figure as a plain SVG, drawn from the same domains, ticks and styles as the
 * canvas chart. It is what the server renders for every figure, what the
 * product-page card shows, and what "SVG" saves. It needs no script. Logged
 * frames are drawn by the interactive chart only.
 *
 * With no `theme` the colours follow the CSS `color-scheme` of the container
 * (`light-dark()`); with a `theme` they are fixed, for the download.
 */

const short = (label: string) => label.replace(/\s*\(.*?\)/g, '');

export function StaticFigure({
  fig,
  width,
  height,
  compact = false,
  theme,
  className,
  title,
  titles = true,
}: {
  fig: Fig;
  width: number;
  height: number;
  /** The product-page card: fewer ticks, the last value written at the line end. */
  compact?: boolean;
  theme?: Theme;
  className?: string;
  title?: string;
  /** Write the y axis titles above the plot. The workspace cards write them in HTML instead. */
  titles?: boolean;
}) {
  const g = buildGeometry(fig, {w: width, h: height, theme, compact, titles, narrow: width < 520, hidden: defaultHidden(fig)});
  const clip = useId().replace(/:/g, '');
  const ink = theme ? INK[theme] : 'var(--tf-ink, currentColor)';
  const muted = theme ? MUTED[theme] : 'var(--tf-muted, currentColor)';
  const grid = theme ? (theme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.045)') : 'var(--tf-grid, rgba(128,128,128,0.18))';
  const surface = theme ? SURFACE[theme] : 'var(--tf-surface, #fff)';
  const colorOf = (s: (typeof g.series)[number]) => (theme ? s.style.color : s.style.colorCss);
  const colorOfId = (id?: string) => {
    const hit = g.series.find((q) => q.id === id);
    return hit ? colorOf(hit) : muted;
  };
  const y2 = fig.axes.y2;
  const lab = (axis: 'x' | 'y' | 'y2') => (compact ? axisTitle({...fig, axes: {...fig.axes, [axis]: {...fig.axes[axis]!, label: short(fig.axes[axis]!.label)}}}, axis) : axisTitle(fig, axis));
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      width={theme ? width : undefined}
      height={theme ? height : undefined}
      role="img"
      aria-label={title ?? fig.title}
      xmlns="http://www.w3.org/2000/svg"
      style={{fontFamily: 'Poppins, ui-sans-serif, system-ui, sans-serif'}}
    >
      {theme ? <rect width={width} height={height} fill={SURFACE[theme]} /> : null}
      {theme ? <title>{fig.title}</title> : null}
      <g stroke={grid} strokeWidth={1} shapeRendering="crispEdges">
        {g.yTicks.map((t) => (
          <line key={`gy${t.p}`} x1={g.plot.x0} x2={g.plot.x1} y1={t.p} y2={t.p} />
        ))}
        <line x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} stroke={muted} strokeOpacity={0.5} />
      </g>
      <g fill={muted} fontSize={TICK_PX} style={{fontVariantNumeric: 'tabular-nums'}}>
        {g.xTicks.map((t, i) => (
          <text key={`x${i}`} x={t.p} y={g.plot.y1 + 15} textAnchor="middle">
            {t.label}
          </text>
        ))}
        {g.yTicks.map((t, i) => (
          <text key={`y${i}`} x={g.plot.x0 - 6} y={t.p + 4} textAnchor="end">
            {t.label}
          </text>
        ))}
        {g.y2Ticks.map((t, i) => (
          <text key={`y2${i}`} x={g.plot.x1 + 6} y={t.p + 4} textAnchor="start">
            {t.label}
          </text>
        ))}
      </g>
      <g fill={muted} fontSize={12}>
        <text x={(g.plot.x0 + g.plot.x1) / 2} y={height - 6} textAnchor="middle">
          {lab('x')}
        </text>
      </g>
      <clipPath id={`${clip}-plot`}>
        <rect x={g.plot.x0} y={g.plot.y0} width={g.plot.x1 - g.plot.x0} height={g.plot.y1 - g.plot.y0} />
      </clipPath>
      {g.series.map((s) => (
        <g key={s.id} fill="none" stroke={colorOf(s)}>
          {s.d ? (
            <path
              d={s.d}
              strokeWidth={s.style.width}
              strokeOpacity={s.kind === 'hold' ? 0.55 : s.style.opacity}
              strokeDasharray={s.style.dash.length ? s.style.dash.join(' ') : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
          {s.bars.map(([x, lo, hi], i) => (
            <path key={`b${i}`} d={`M${x} ${lo}V${hi}M${x - 4} ${lo}H${x + 4}M${x - 4} ${hi}H${x + 4}`} strokeWidth={1.5} strokeOpacity={0.9} />
          ))}
          {s.dots.map(([x, y], i) => (
            <path
              key={`d${i}`}
              d={markerPath(s.style.marker, x, y, s.kind === 'hold' ? MARKER_R : 2.5)}
              fill={s.kind === 'hold' && !s.style.hollow ? colorOf(s) : surface}
              stroke={colorOf(s)}
              strokeWidth={s.kind === 'hold' && !s.style.hollow ? 0 : 1.25}
            />
          ))}
        </g>
      ))}
      {g.fit ? <path d={g.fit} clipPath={`url(#${clip}-plot)`} fill="none" stroke={ink} strokeWidth={1.75} strokeDasharray="7 4" /> : null}
      {g.lines.map((l, li) => (
        <g key={`ml${li}`}>
          <line x1={l.x} x2={l.x} y1={g.plot.y1} y2={g.plot.y1 - 8} stroke={ink} strokeWidth={1.25} />
          <text x={l.x} y={g.plot.y1 - 12} textAnchor="middle" fontSize={12} fontWeight={500} fill={ink}>
            {l.text}
          </text>
        </g>
      ))}
      {g.rings.map(([x, y, c], i) => (
        <circle key={`r${i}`} cx={x} cy={y} r={MARKER_R + 4} fill="none" stroke={colorOfId(c)} strokeWidth={1.5} />
      ))}
      {g.notes.map((n, i) =>
        n.leader ? (
          <line key={`l${i}`} x1={n.leader[0]} y1={n.leader[1]} x2={n.leader[2]} y2={n.leader[3]} stroke={colorOfId(n.sid)} strokeWidth={1} />
        ) : null,
      )}
      {g.notes.map((n, i) => (
        <text key={`n${i}`} fontSize={12} fontWeight={500} fill={n.sid ? colorOfId(n.sid) : muted} textAnchor="start">
          {n.lines.map((t, k) => (
            <tspan key={k} x={n.left} y={n.top + 11 + k * (TICK_PX + 3)}>
              {t}
            </tspan>
          ))}
        </text>
      ))}
      {titles ? (
        <g fontSize={12} fontWeight={500}>
          <text x={4} y={14} textAnchor="start" fill={muted}>
            {lab('y')}
          </text>
          {y2 ? (
            <text x={width - 4} y={14} textAnchor="end" fill={muted}>
              {lab('y2')}
            </text>
          ) : null}
        </g>
      ) : null}
    </svg>
  );
}
