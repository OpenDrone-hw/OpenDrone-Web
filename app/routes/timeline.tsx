import {useEffect, useMemo, useRef, useState} from 'react';
import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/timeline';
import {
  fetchTimelineLedger,
  tagForRepo,
  type LedgerEvent,
} from '~/lib/timeline-ledger';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {CONTRIBUTING_URL} from '~/lib/company';
import {copyText} from '~/lib/copy';

/**
 * Every word on this page comes from `content/copy/timeline.json`, edited in
 * the studio. What stays here is structure and evidence: which events exist,
 * their dates, tags, kinds and receipt URLs. An event's title and detail are
 * copy, keyed off its `id`; its date is not, because the same date sorts the
 * list and groups it by year.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('timeline.meta_title') ?? 'Timeline',
    description: copyText('timeline.meta_description') ?? '',
  });

/**
 * The machine half of the page: releases, repos and status flips from the
 * ledger (app/lib/timeline-ledger.ts), best-effort. A miss just leaves the
 * curated list on its own.
 */
export async function loader(_args: Route.LoaderArgs) {
  const ledger = await fetchTimelineLedger();
  return {ledgerEvents: ledger?.events ?? []};
}

type EventKind =
  | 'commit'
  | 'order'
  | 'validation'
  | 'cert'
  | 'upstream'
  | 'launch'
  | 'status'
  | 'post';

type TimelineEvent = {
  /** Copy key stem: `event_<id>_title` and optional `event_<id>_detail`,
   *  unless `title` is set (ledger events carry their words resolved). */
  id: string;
  date: string; // YYYY-MM-DD
  /** Filter tag: esc | fc | rx | frame | company. Untagged = company. */
  tag?: 'esc' | 'fc' | 'rx' | 'frame' | 'company';
  kind: EventKind;
  /** Public receipt: repo, commit, tag, certification, or post. */
  url?: string;
  title?: string;
  detail?: string;
};

const KIND_GLYPH: Record<EventKind, string> = {
  commit: '⌥',
  order: '▦',
  validation: '✓',
  cert: '◉',
  upstream: '⇪',
  launch: '⚑',
  status: '⇢',
  post: '✎',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function fill(id: string, fallback: string, vars: Record<string, string>): string {
  let out = copyText(id) ?? fallback;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

/** Ledger events as timeline rows: words from the copy templates, tag from
 *  the repo, kind mapped onto the page's glyph vocabulary. Archived repos
 *  and pre-releases still list; they are dated facts. */
function fromLedger(e: LedgerEvent): TimelineEvent | null {
  const tag = tagForRepo(e.repo);
  if (e.kind === 'release' && e.tag) {
    return {
      id: e.id,
      date: e.date,
      tag,
      kind: 'launch',
      url: e.url,
      title: fill(
        e.prerelease
          ? 'timeline.auto_release_prerelease_title'
          : 'timeline.auto_release_title',
        e.prerelease ? '{repo} {tag} pre-release' : '{repo} {tag} released',
        {repo: e.repo, tag: e.tag},
      ),
      // A release name that only restates repo + tag ("OpenRX Rev 2.1")
      // is not a detail.
      detail:
        e.name && norm(e.name) !== norm(`${e.repo} ${e.tag}`)
          ? e.name
          : undefined,
    };
  }
  if (e.kind === 'repo') {
    return {
      id: e.id,
      date: e.date,
      tag,
      kind: 'commit',
      url: e.url,
      title: fill('timeline.auto_repo_title', '{repo}: repository opened', {
        repo: e.repo,
      }),
    };
  }
  if (e.kind === 'status' && e.status) {
    return {
      id: e.id,
      date: e.date,
      tag,
      kind: 'status',
      url: e.url,
      title: fill('timeline.auto_status_title', '{repo} moved to {status}', {
        repo: e.repo,
        status: e.status,
      }),
      detail: e.from
        ? fill(
            'timeline.auto_status_from_detail',
            'From {from}, per the status-* topic on the repo.',
            {from: e.from},
          )
        : undefined,
    };
  }
  return null;
}

/** A curated entry that names the same fact wins over the ledger's: same
 *  tag and kind within a week (repo openings vs hand-written first
 *  commits, a hand-noted release vs its tag). */
function dedupe(curated: TimelineEvent[], auto: TimelineEvent[]): TimelineEvent[] {
  const day = 86_400_000;
  return auto.filter(
    (a) =>
      !curated.some(
        (c) =>
          (c.tag ?? 'company') === (a.tag ?? 'company') &&
          c.kind === a.kind &&
          Math.abs(Date.parse(c.date) - Date.parse(a.date)) <= 7 * day,
      ),
  );
}

const FILTERS: Array<{key: 'all' | NonNullable<TimelineEvent['tag']>}> = [
  {key: 'all'},
  {key: 'esc'},
  {key: 'fc'},
  {key: 'rx'},
  {key: 'frame'},
  {key: 'company'},
];

/**
 * Verified events only: each entry's date and claim must be reproducible
 * from the linked receipt (git history, OSHWA directory, published post).
 * Keep newest LAST in this array; the page renders newest first.
 */
const TIMELINE: TimelineEvent[] = [
  {id: 'esc20_first_commit', date: '2026-03-09', tag: 'esc', kind: 'commit', url: 'https://github.com/OpenDrone-hw/OpenESC-20x20/commits/main'},
  {id: 'esc_build_video', date: '2026-03-10', tag: 'esc', kind: 'post', url: 'https://www.youtube.com/watch?v=TwAmmPxOpTM'},
  {id: 'esc30_repo_split', date: '2026-03-11', tag: 'esc', kind: 'commit', url: 'https://github.com/OpenDrone-hw/OpenESC-30x30/commits/main'},
  {id: 'esc_first_production_files', date: '2026-03-16', tag: 'esc', kind: 'order', url: 'https://github.com/OpenDrone-hw/OpenESC-20x20'},
  {id: 'fc_mini_first_commit', date: '2026-03-19', tag: 'fc', kind: 'commit', url: 'https://github.com/OpenDrone-hw/OpenFC-Lite-Mini/commits/main'},
  {id: 'web_first_commit', date: '2026-03-21', tag: 'company', kind: 'commit', url: 'https://github.com/OpenDrone-hw/OpenDrone-Web/commits/main'},
  {id: 'rx_first_commit', date: '2026-03-23', tag: 'rx', kind: 'commit', url: 'https://github.com/OpenDrone-hw/OpenRX/commits/main'},
  {id: 'bf_osd_merged', date: '2026-04-22', tag: 'fc', kind: 'upstream', url: 'https://github.com/betaflight/betaflight/pull/14882'},
  {id: 'fc_build_video', date: '2026-05-25', tag: 'fc', kind: 'post', url: 'https://www.youtube.com/watch?v=XDYZoMRJFeQ'},
  {id: 'fc_lite_first_commit', date: '2026-06-03', tag: 'fc', kind: 'commit', url: 'https://github.com/OpenDrone-hw/OpenFC-Lite/commits/main'},
  {id: 'esc_validation_exports', date: '2026-06-05', tag: 'esc', kind: 'order', url: 'https://github.com/OpenDrone-hw/OpenESC-20x20'},
  {id: 'rx_fab_ordered', date: '2026-06-10', tag: 'rx', kind: 'order', url: 'https://github.com/OpenDrone-hw/OpenRX'},
  {id: 'charger_first_commit', date: '2026-06-14', tag: 'company', kind: 'commit', url: 'https://github.com/OpenDrone-hw/Charger/commits/main'},
  {id: 'site_redesign', date: '2026-06-21', tag: 'company', kind: 'launch', url: 'https://github.com/OpenDrone-hw/OpenDrone-Web'},
  {id: 'library_first_commit', date: '2026-06-29', tag: 'company', kind: 'commit', url: 'https://github.com/OpenDrone-hw/KiCad-Library/commits/main'},
  {id: 'frame_first_commit', date: '2026-07-05', tag: 'frame', kind: 'commit'},
  {id: 'esc_bench_validation', date: '2026-07-05', tag: 'esc', kind: 'validation'},
  {id: 'rx_rf_baselines', date: '2026-07-06', tag: 'rx', kind: 'validation'},
  {id: 'rx_range_video', date: '2026-07-18', tag: 'rx', kind: 'post', url: 'https://www.youtube.com/watch?v=ssmQkRkXE84'},
  {id: 'esc20_rework_proposal', date: '2026-07-25', tag: 'esc', kind: 'upstream', url: 'https://github.com/OpenDrone-hw/OpenESC-20x20/issues/8'},
  {id: 'frame_samples_ordered', date: '2026-07-28', tag: 'frame', kind: 'order'},
  {id: 'library_live', date: '2026-08-04', tag: 'company', kind: 'launch', url: 'https://github.com/OpenDrone-hw/KiCad-Library'},
  {id: 'frame_v01_tagged', date: '2026-08-04', tag: 'frame', kind: 'launch'},
  {id: 'batch1_planned', date: '2026-08-04', tag: 'company', kind: 'order'},
  {id: 'hardware_validated', date: '2026-08-05', tag: 'company', kind: 'validation'},
  {id: 'oshwa_certified', date: '2026-08-05', tag: 'company', kind: 'cert', url: 'https://certification.oshwa.org/list.html'},
  {id: 'release_tags_cut', date: '2026-08-06', tag: 'company', kind: 'launch', url: 'https://github.com/OpenDrone-hw'},
  {id: 'batch1_paid', date: '2026-09-03', tag: 'company', kind: 'order'},
];

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Scroll-driven trace: the gold spine draws downward as the visitor
 * scrolls and each pad lights once passed. Pure CSS custom property +
 * class toggles; reduced motion renders everything on.
 */
function useTraceProgress(
  rootRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const rows = root.querySelectorAll<HTMLElement>('.tl-event');
    if (reduce) {
      root.style.setProperty('--tl-progress', '1');
      rows.forEach((r) => r.classList.add('is-passed'));
      return;
    }
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = root.getBoundingClientRect();
        const viewH = window.innerHeight;
        // Progress: how far the viewport's 70% line has travelled through
        // the timeline block.
        const line = viewH * 0.7;
        const p = Math.min(1, Math.max(0, (line - rect.top) / rect.height));
        root.style.setProperty('--tl-progress', p.toFixed(4));
        rows.forEach((r) => {
          const rr = r.getBoundingClientRect();
          r.classList.toggle('is-passed', rr.top < line);
        });
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, {passive: true});
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rootRef]);
}

export default function TimelineRoute() {
  const {ledgerEvents} = useLoaderData<typeof loader>();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const rootRef = useRef<HTMLDivElement | null>(null);
  useTraceProgress(rootRef);

  // Curated + ledger, newest first, grouped by year.
  const all = useMemo(() => {
    const auto = (ledgerEvents as LedgerEvent[])
      .map(fromLedger)
      .filter((e): e is TimelineEvent => e !== null);
    return [...TIMELINE, ...dedupe(TIMELINE, auto)];
  }, [ledgerEvents]);
  const groups = useMemo(() => {
    const events = [...all]
      .filter((e) => filter === 'all' || (e.tag ?? 'company') === filter)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const byYear = new Map<string, TimelineEvent[]>();
    for (const e of events) {
      const y = e.date.slice(0, 4);
      byYear.set(y, [...(byYear.get(y) ?? []), e]);
    }
    return [...byYear.entries()];
  }, [all, filter]);

  return (
    <EditorialShell slug="timeline" pageClassName="timeline-page">
      <header className="editorial-hero">
        <Txt id="timeline.title" as="h1" className="editorial-title" />
        <Txt id="timeline.lead" as="p" className="editorial-lead" />
        <div
          className="tl-filters"
          role="group"
          aria-label="Filter timeline by product"
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`tl-filter${filter === f.key ? ' is-active' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              <Txt id={`timeline.filter_${f.key}`} />
            </button>
          ))}
        </div>
      </header>

      <div className="tl-root" ref={rootRef}>
        <div className="tl-trace" aria-hidden="true" />
        {groups.map(([year, events]) => (
          <section key={year} className="tl-year">
            <h2 className="tl-year-label">{year}</h2>
            <ol className="tl-events">
              {events.map((e) => (
                <li key={e.id} className="tl-event">
                  <span className="tl-pad" aria-hidden="true" />
                  <div className="tl-card">
                    <p className="tl-date">
                      <span className="tl-glyph" aria-hidden="true">
                        {KIND_GLYPH[e.kind]}
                      </span>
                      {fmtDate(e.date)}
                      {e.tag && e.tag !== 'company' ? (
                        <span className="tl-tag">{e.tag.toUpperCase()}</span>
                      ) : null}
                    </p>
                    <h3 className="tl-title">
                      {e.url ? (
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {e.title ?? (
                            <Txt id={`timeline.event_${e.id}_title`} />
                          )}{' '}
                          ↗
                        </a>
                      ) : (
                        (e.title ?? <Txt id={`timeline.event_${e.id}_title`} />)
                      )}
                    </h3>
                    {/* No detail key on this event renders nothing. */}
                    {e.title ? (
                      e.detail ? (
                        <p className="tl-detail">{e.detail}</p>
                      ) : null
                    ) : (
                      <Txt
                        id={`timeline.event_${e.id}_detail`}
                        as="p"
                        className="tl-detail"
                      />
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
        {groups.length === 0 ? (
          <Txt id="timeline.empty" as="p" className="tl-empty" />
        ) : null}
      </div>

      <section className="editorial-cta">
        <Link prefetch="viewport" to="/roadmap" className="editorial-cta-primary">
          <Txt id="timeline.cta_primary" />
        </Link>
        <a
          // "Put yourself on this timeline" is a contributing pitch, not a
          // second roadmap link (audit 2026-08-12).
          href={CONTRIBUTING_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="editorial-cta-secondary"
        >
          <Txt id="timeline.cta_secondary" />
        </a>
      </section>
    </EditorialShell>
  );
}
