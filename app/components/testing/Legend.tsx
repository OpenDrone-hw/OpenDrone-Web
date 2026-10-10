import {assignStyles, type Theme} from '~/lib/testing/palette';
import {markerPath} from '~/lib/testing/geometry';
import type {Fig} from '~/lib/testing/types';

/**
 * Toggle chips. Click shows or hides a series; double-click isolates it, and
 * double-click on the isolated one shows all again. Each chip carries the
 * line's shade, dash and marker next to its written label, so colour is never
 * the only cue.
 */
export function Legend({
  fig,
  theme,
  hidden,
  onChange,
}: {
  fig: Fig;
  theme: Theme;
  hidden: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const styles = assignStyles(fig.series, theme);
  const ids = fig.series.map((s) => s.id);
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else if (ids.length - next.size > 1) next.add(id);
    onChange(next);
  };
  const isolate = (id: string) => {
    const only = ids.filter((i) => i !== id);
    const alreadyIsolated = only.every((i) => hidden.has(i)) && !hidden.has(id);
    onChange(alreadyIsolated ? new Set() : new Set(only));
  };
  return (
    <ul className="tw-legend" aria-label="Series">
      {fig.series.map((s) => {
        const st = styles[s.id]!;
        const off = hidden.has(s.id);
        return (
          <li key={s.id}>
            <button
              type="button"
              className="tw-chip-btn"
              aria-pressed={!off}
              onClick={() => toggle(s.id)}
              onDoubleClick={() => isolate(s.id)}
              title="Click to hide or show. Double-click to show only this series."
            >
              <svg width="30" height="14" viewBox="0 0 30 14" aria-hidden="true">
                {s.kind === 'hold' ? null : (
                  <line
                    x1="1"
                    x2="29"
                    y1="7"
                    y2="7"
                    stroke={st.color}
                    strokeWidth={st.width + 0.5}
                    strokeOpacity={st.opacity}
                    strokeDasharray={st.dash.length ? st.dash.join(' ') : undefined}
                  />
                )}
                <path d={markerPath(st.marker, 15, 7, 4)} fill={s.kind === 'hold' || s.x.length <= 24 ? st.color : 'none'} stroke={s.kind === 'hold' || s.x.length <= 24 ? st.color : 'none'} />
              </svg>
              <span>{s.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
