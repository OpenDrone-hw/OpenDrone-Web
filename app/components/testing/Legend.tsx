import {assignStyles, type Theme} from '~/lib/testing/palette';
import {connectsHolds, DOT_R, markerPath} from '~/lib/testing/geometry';
import {defaultHidden, frameIdsOf, plainLabel} from '~/lib/testing/labels';
import type {Fig} from '~/lib/testing/types';

export {defaultHidden, plainLabel};

type S = Fig['series'][number];
const keyOf = (s: S) => `${s.quantity}/${s.pack ?? s.id}`;

/**
 * Inline legend: a swatch and a short name per run or trace, then the fit and
 * a switch for the raw frames when the figure has them. Frames and hold markers
 * of one run are one entry. Click hides or shows a run; double-click shows only
 * that one, and double-click again shows all. The swatch carries the line's
 * dash and marker shape, so colour is never the only cue. A figure whose lines
 * are named on the plot, or whose two axes are named in colour, has no entry
 * for them.
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
  const groups = new Map<string, {key: string; label: string; ids: string[]; lead: S}>();
  const frameIds = frameIdsOf(fig);
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
  // Only what is drawn is listed: raw frames that start hidden have no entry.
  const framesShown = frameIds.some((i) => !hidden.has(i));
  if (!list.length && !framesShown && !fig.fit) return null;
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
    onChange(already ? new Set(frameIds.length ? frameIds : []) : new Set(others));
  };
  const joined = connectsHolds(fig);
  return (
    <ul className="tw-legend" aria-label="Series">
      {list.map((g) => {
        const st = styles[g.lead.id]!;
        const off = isOff(g.ids);
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
                {g.lead.kind === 'hold' && !joined ? null : (
                  <line
                    x1="1"
                    x2="25"
                    y1="6"
                    y2="6"
                    stroke={st.color}
                    strokeWidth={st.width}
                    strokeOpacity={g.lead.kind === 'hold' ? 0.55 : 1}
                    strokeDasharray={st.dash.length ? st.dash.join(' ') : undefined}
                  />
                )}
                <path d={markerPath(st.marker, 13, 6, DOT_R)} fill={st.hollow ? 'var(--tf-surface)' : st.color} stroke={st.color} strokeWidth="1.25" />
              </svg>
              <span>{plainLabel(g.label, g.lead.short)}</span>
            </button>
          </li>
        );
      })}
      {fig.fit ? (
        <li>
          <span className="tw-key tw-key-static">
            <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
              <line x1="1" x2="25" y1="6" y2="6" stroke="var(--tf-ink)" strokeOpacity="0.6" strokeWidth="1.25" strokeDasharray="5 4" />
            </svg>
            <span>Quadratic fit</span>
          </span>
        </li>
      ) : null}
      {framesShown ? (
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
            <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
              <circle cx="7" cy="7" r="1.8" fill="var(--tf-muted)" />
              <circle cx="13" cy="4" r="1.8" fill="var(--tf-muted)" />
              <circle cx="19" cy="6" r="1.8" fill="var(--tf-muted)" />
            </svg>
            <span>Raw frames</span>
          </button>
        </li>
      ) : null}
    </ul>
  );
}
