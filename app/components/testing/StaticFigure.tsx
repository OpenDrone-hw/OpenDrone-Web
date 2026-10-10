import {buildGeometry, markerPath, TICK_PX} from '~/lib/testing/geometry';
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
}: {
  fig: Fig;
  width: number;
  height: number;
  /** The product-page card: fewer ticks, the last value written at the line end. */
  compact?: boolean;
  theme?: Theme;
  className?: string;
  title?: string;
}) {
  const g = buildGeometry(fig, {w: width, h: height, theme, compact});
  const ink = theme ? INK[theme] : 'var(--tf-ink, currentColor)';
  const muted = theme ? MUTED[theme] : 'var(--tf-muted, currentColor)';
  const grid = theme ? (theme === 'dark' ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)') : 'var(--tf-grid, rgba(128,128,128,0.18))';
  const surface = theme ? SURFACE[theme] : 'var(--tf-surface, #fff)';
  const colorOf = (s: (typeof g.series)[number]) => (theme ? s.style.color : s.style.colorCss);
  const y2 = fig.axes.y2;
  const lab = (a: {label: string; unit: string}) => `${compact ? short(a.label) : a.label} (${a.unit})`;
  const endRight = g.end ? g.end.x + 8 + g.end.text.length * 6.2 > g.plot.x1 : false;
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
      <g fill={muted} fontSize={TICK_PX}>
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
        <text x={(g.plot.x0 + g.plot.x1) / 2} y={height - 4} textAnchor="middle">
          {lab(fig.axes.x)}
        </text>
      </g>
      {g.fit ? <path d={g.fit} fill="none" stroke={ink} strokeOpacity={0.55} strokeWidth={1} strokeDasharray="5 4" /> : null}
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
            <line key={`b${i}`} x1={x} x2={x} y1={lo + Math.max(0, 2.5 - Math.abs(lo - hi) / 2)} y2={hi - Math.max(0, 2.5 - Math.abs(lo - hi) / 2)} strokeWidth={5} strokeOpacity={0.3} strokeLinecap="round" />
          ))}
          {s.dots.map(([x, y], i) => (
            <path
              key={`d${i}`}
              d={markerPath(s.style.marker, x, y, s.kind === 'hold' ? 3 : 2.5)}
              fill={s.kind === 'hold' ? colorOf(s) : surface}
              stroke={s.kind === 'hold' ? surface : colorOf(s)}
              strokeWidth={s.kind === 'hold' ? 1 : 1.5}
            />
          ))}
        </g>
      ))}
      {compact && g.end ? (
        <text
          x={endRight ? g.end.x - 8 : g.end.x + 8}
          y={endRight ? g.end.y - 9 : g.end.y + 4}
          textAnchor={endRight ? 'end' : 'start'}
          fontSize={12}
          fontWeight={500}
          fill={ink}
        >
          {g.end.text}
        </text>
      ) : null}
      {y2 ? (
        <text fill={muted} fontSize={12} transform={`translate(${width - 4} ${(g.plot.y0 + g.plot.y1) / 2}) rotate(90)`} textAnchor="middle">
          {lab(y2)}
        </text>
      ) : null}
      <text fill={muted} fontSize={12} transform={`translate(12 ${(g.plot.y0 + g.plot.y1) / 2}) rotate(-90)`} textAnchor="middle">
        {lab(fig.axes.y)}
      </text>
      {theme ? <rect x={0} y={0} width={width} height={height} fill="none" stroke={CANVAS[theme]} /> : null}
    </svg>
  );
}
