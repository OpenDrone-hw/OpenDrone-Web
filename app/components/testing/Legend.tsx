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
  const keyOf = (s: (typeof fig.series)[number]) => `${s.quantity}/${s.pack ?? s.id}`;
  // Raw frames have their own switch, unless a pack has nothing else.
  const framed = new Set(fig.series.filter((s) => s.kind !== 'frames').map(keyOf));
  const frameIds = fig.series.filter((s) => s.kind === 'frames' && framed.has(keyOf(s))).map((s) => s.id);
  for (const s of fig.series) {
    if (frameIds.includes(s.id)) continue;
    const key = keyOf(s);
    const g = groups.get(key);
    if (g) {
      g.ids.push(s.id);
      if (s.kind === 'hold') g.lead = s;
    } else groups.set(key, {key, label: s.label, ids: [s.id], lead: s});
  }
  const list = [...groups.values()];
  if (list.length < 2 && !fig.series.some((s) => s.axis === 'y2') && !frameIds.length) return null;
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
              <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
                {g.lead.kind === 'hold' ? null : (
                  <line
                    x1="1"
                    x2="25"
                    y1="6"
                    y2="6"
                    stroke={st.color}
                    strokeWidth={st.width}
                    strokeDasharray={st.dash.length ? st.dash.join(' ') : undefined}
                  />
                )}
                <path d={markerPath(st.marker, 13, 6, 4)} fill={st.color} stroke="var(--tf-surface)" strokeWidth="1.5" />
              </svg>
              <span>{plainLabel(g.label)}</span>
              {g.lead.axis === 'y2' && ax ? <em>right axis</em> : null}
            </button>
          </li>
        );
      })}
      {frameIds.length ? (
        <li>
          <button
            type="button"
            className="tw-key tw-key-frames"
            aria-pressed={!isOff(frameIds)}
            onClick={() => {
              const next = new Set(hidden);
              for (const i of frameIds) {
                if (isOff(frameIds)) next.delete(i);
                else next.add(i);
              }
              onChange(next);
            }}
          >
            <span>Raw frames</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}
