import {buildGeometry, markerPath, TICK_PX} from '~/lib/testing/geometry';
import {CANVAS, INK, MUTED, SURFACE, type Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';

/**
 * A figure as a plain SVG, drawn from the same domains, ticks and styles as the
 * canvas chart. It is what the server renders for every figure, what the
 * product-page card shows, and what "Download SVG" saves. It needs no script.
 *
 * With no `theme` the colours follow the CSS `color-scheme` of the container
 * (`light-dark()`); with a `theme` they are fixed, for the download.
 */
export function StaticFigure({
  fig,
  width,
  height,
  compact = false,
  theme,
  className,
  title,
}: {
  fig: Fig;
  width: number;
  height: number;
  compact?: boolean;
  theme?: Theme;
  className?: string;
  title?: string;
}) {
  const g = buildGeometry(fig, {w: width, h: height, theme, compact});
  const ink = theme ? INK[theme] : 'var(--tf-ink, currentColor)';
  const muted = theme ? MUTED[theme] : 'var(--tf-muted, currentColor)';
  const grid = theme ? (theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)') : 'var(--tf-grid, rgba(128,128,128,0.18))';
  const colorOf = (s: (typeof g.series)[number]) => (theme ? s.style.color : s.style.colorCss);
  const y2 = fig.axes.y2;
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
        {compact
          ? null
          : g.yTicks.map((t) => (
              <line key={`gy${t.p}`} x1={g.plot.x0} x2={g.plot.x1} y1={t.p} y2={t.p} />
            ))}
        <line x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} stroke={muted} strokeOpacity={0.5} />
      </g>
      <g fill={muted} fontSize={TICK_PX}>
        {g.xTicks.map((t, i) => (
          <text
            key={`x${i}`}
            x={t.p}
            y={g.plot.y1 + 17}
            textAnchor={compact ? (i === 0 ? 'start' : 'end') : 'middle'}
          >
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
      {compact ? null : (
        <g fill={ink} fontSize={14}>
          <text x={(g.plot.x0 + g.plot.x1) / 2} y={height - 4} textAnchor="middle" fill={ink}>
            {fig.axes.x.label} ({fig.axes.x.unit})
          </text>
        </g>
      )}
      {g.series.map((s) => (
        <g key={s.id} fill="none" stroke={colorOf(s)}>
          {s.d ? (
            <path
              d={s.d}
              strokeWidth={s.style.width}
              strokeOpacity={s.style.opacity}
              strokeDasharray={s.style.dash.length ? s.style.dash.join(' ') : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
          {s.bars.map(([x, lo, hi], i) => (
            <line key={`b${i}`} x1={x} x2={x} y1={lo + Math.max(0, 3 - Math.abs(lo - hi) / 2)} y2={hi - Math.max(0, 3 - Math.abs(lo - hi) / 2)} strokeWidth={5} strokeOpacity={0.35} strokeLinecap="round" />
          ))}
          {s.dots.map(([x, y], i) => (
            <path
              key={`d${i}`}
              d={markerPath(s.style.marker, x, y, s.kind === 'hold' ? 4 : 3)}
              fill={s.kind === 'hold' ? colorOf(s) : theme ? SURFACE[theme] : 'var(--tf-surface, #fff)'}
              strokeWidth={1.5}
            />
          ))}
        </g>
      ))}
      {compact || !y2 ? null : (
        <text fill={ink} fontSize={14} transform={`translate(${width - 6} ${(g.plot.y0 + g.plot.y1) / 2}) rotate(90)`} textAnchor="middle">
          {y2.label} ({y2.unit})
        </text>
      )}
      {compact ? null : (
        <text fill={ink} fontSize={14} transform={`translate(14 ${(g.plot.y0 + g.plot.y1) / 2}) rotate(-90)`} textAnchor="middle">
          {fig.axes.y.label} ({fig.axes.y.unit})
        </text>
      )}
      {theme ? <rect x={0} y={0} width={width} height={height} fill="none" stroke={CANVAS[theme]} /> : null}
    </svg>
  );
}
