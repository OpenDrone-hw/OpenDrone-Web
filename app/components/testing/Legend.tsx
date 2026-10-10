import {assignStyles, type Theme} from '~/lib/testing/palette';
import {markerPath} from '~/lib/testing/geometry';
import type {Fig} from '~/lib/testing/types';

/** The label without the wording every series of a figure shares. */
export function plainLabel(label: string): string {
  return label
    .replace(/, (frames|hold median.*)$/, '')
    .replace(/^(\d{2}:\d{2}) UTC run$/, 'run $1');
}

/**
 * Inline legend: a swatch and a short name per run or trace. Frames and hold
 * markers of one run are one entry. Click hides or shows it; double-click shows
 * only that one, and double-click again shows all. The swatch carries the
 * line's dash and marker shape, so colour is never the only cue.
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
  const groups = new Map<string, {key: string; label: string; ids: string[]; lead: (typeof fig.series)[number]}>();
  for (const s of fig.series) {
    const key = `${s.quantity}/${s.pack ?? s.id}`;
    const g = groups.get(key);
    if (g) {
      g.ids.push(s.id);
      if (s.kind === 'hold') g.lead = s;
    } else groups.set(key, {key, label: s.pack ? s.label : s.label, ids: [s.id], lead: s});
  }
  const list = [...groups.values()];
  if (list.length < 2 && !fig.series.some((s) => s.axis === 'y2')) return null;
  const allIds = fig.series.map((s) => s.id);
  const isOff = (ids: string[]) => ids.every((i) => hidden.has(i));
  const toggle = (ids: string[]) => {
    const next = new Set(hidden);
    if (isOff(ids)) ids.forEach((i) => next.delete(i));
    else if (allIds.length - next.size > ids.length) ids.forEach((i) => next.add(i));
    onChange(next);
  };
  const isolate = (ids: string[]) => {
    const others = allIds.filter((i) => !ids.includes(i));
    const already = others.every((i) => hidden.has(i)) && !isOff(ids);
    onChange(already ? new Set() : new Set(others));
  };
  return (
    <ul className="tw-legend" aria-label="Series">
      {list.map((g) => {
        const st = styles[g.lead.id]!;
        const off = isOff(g.ids);
        const ax = g.lead.axis === 'y2' ? fig.axes.y2 : fig.axes.y;
        return (
          <li key={g.key}>
            <button
              type="button"
              className="tw-key"
              aria-pressed={!off}
              onClick={() => toggle(g.ids)}
              onDoubleClick={() => isolate(g.ids)}
              title="Click to hide or show. Double-click to show only this one."
            >
              <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
                {g.lead.kind === 'hold' ? null : (
                  <line
                    x1="1"
                    x2="21"
                    y1="5"
                    y2="5"
                    stroke={st.color}
                    strokeWidth={st.width + 0.5}
                    strokeDasharray={st.dash.length ? st.dash.join(' ') : undefined}
                  />
                )}
                <path d={markerPath(st.marker, 11, 5, 3)} fill={st.color} />
              </svg>
              <span>{plainLabel(g.label)}</span>
              {g.lead.axis === 'y2' && ax ? <em>right axis</em> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
