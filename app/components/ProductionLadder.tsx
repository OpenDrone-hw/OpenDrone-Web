import {Txt} from '~/components/Txt';
import {goals} from '~/lib/goals';

/**
 * The production page's visual column: the capability climb, drawn from the
 * SAME data as the financial goals (`content/goals.json`), so the ladder can
 * never promise something the goals do not.
 *
 * Shape, per the maintainer (2026-08-11): the filled node is where we are today
 * (inspect/flash/ship from Belgium), a SOLID line climbs to the goal being
 * saved for, and a DOTTED line continues to the one after it, which is
 * openly speculative. Nothing beyond that is drawn, and nothing carries a
 * date. Completed goals stack above as a record.
 */
import type {Goal} from '~/lib/goals';

type Rung = {
  key: string;
  kind: 'done' | 'now' | 'current' | 'next';
  /** The goal behind this rung, or undefined for the fixed "now" rung. */
  goal?: Goal;
};

export function ProductionLadder() {
  const list = goals();
  const rungs: Rung[] = [
    ...list
      .filter((g) => g.status === 'done')
      .map((g): Rung => ({key: g.id, kind: 'done', goal: g})),
    {key: 'now', kind: 'now'},
    ...list
      .filter((g) => g.status === 'current')
      .slice(0, 1)
      .map((g): Rung => ({key: g.id, kind: 'current', goal: g})),
    ...list
      .filter((g) => g.status === 'next')
      .slice(0, 1)
      .map((g): Rung => ({key: g.id, kind: 'next', goal: g})),
  ];

  return (
    <figure className="ladder">
      <ol className="ladder-rungs">
        {rungs.map((r, i) => (
          <li
            key={r.key}
            className="ladder-rung"
            data-kind={r.kind}
            // The connector below this node: dotted when it climbs into the
            // speculative rung, solid otherwise.
            data-seg={
              i === rungs.length - 1
                ? undefined
                : rungs[i + 1].kind === 'next'
                  ? 'dashed'
                  : 'solid'
            }
          >
            <Txt
              id={
                r.kind === 'now'
                  ? 'production.ladder_now_when'
                  : `roadmap.goals_status_${r.kind === 'done' ? 'done' : r.kind === 'current' ? 'current' : 'next'}`
              }
              className="ladder-when"
            />
            {r.kind === 'now' ? (
              <Txt id="production.ladder_now_title" className="ladder-title" />
            ) : (
              <span className="ladder-title">{r.goal?.title}</span>
            )}
            {/* The rung explains itself: what this capability unlocks, how
                far the saving is, what it roughly costs. Same goals.json the
                studio edits, so the ladder updates as the plan does - new
                goals become new rungs, finished ones stack above as record. */}
            {r.goal && (r.kind === 'current' || r.kind === 'next') ? (
              <>
                <p className="ladder-body">{r.goal.body}</p>
                <div className="goal-meter-row ladder-meter-row">
                  <span
                    className="goal-meter"
                    role="img"
                    aria-label={`${r.goal.progress_pct}%`}
                  >
                    <span
                      className="goal-meter-fill"
                      style={{width: `${r.goal.progress_pct}%`}}
                    />
                  </span>
                  <span className="goal-target">
                    <Txt id="roadmap.goals_target_prefix" /> {r.goal.target_label}
                  </span>
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      <Txt id="production.ladder_note" as="p" className="ladder-note" />
    </figure>
  );
}
