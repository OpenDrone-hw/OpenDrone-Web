import {data} from 'react-router';
import type {Route} from './+types/owners';
import {EditorialShell} from '~/components/EditorialShell';
import {OwnerMap} from '~/components/OwnerMap';
import {PilotMap, pilotNotice} from '~/components/PilotMap';
import {Txt} from '~/components/Txt';
import {copyFill, copyText, editAttrs} from '~/lib/copy';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {countryName, STATE_NAME} from '~/lib/owner-map-geo';
import {loadOwnerMap, ownerMapFixture} from '~/lib/owner-map-data';
import {pilotPanel} from '~/lib/pilot-map-server';
import {OTHER_COUNTRIES, OTHER_US_STATES, bucketLabel, type Snapshot} from '~/lib/owner-map';

/**
 * The public owners map: owners per country and US state, as published
 * buckets only (app/lib/owner-map.ts holds the suppression rules, README
 * "Owners map" the whole feature). Words live in `content/copy/owners.json`.
 *
 * The page also carries the opt-in pilot map (app/components/PilotMap.tsx)
 * while PILOT_MAP_ENABLED is "1". What a viewer may see of it is decided in
 * the loader from the session; with the flag on, the response is per viewer
 * and never cached.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('owners.meta_title') ?? 'OpenDrone owners map',
    description: copyText('owners.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/owners`,
  });

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env as unknown as Parameters<typeof loadOwnerMap>[0];
  const {panel, cookies} = await pilotPanel(context.env, request);
  const notice = pilotNotice(new URL(request.url).searchParams.get('pilot'));
  const body = {snapshot: await loadOwnerMap(env), fixture: ownerMapFixture(env), pilot: panel, notice: panel.enabled ? notice : null};
  if (!panel.enabled) return body;
  const headers = new Headers({'Cache-Control': 'private, no-store'});
  for (const c of cookies) headers.append('Set-Cookie', c);
  return data(body, {headers});
}

export function headers({loaderHeaders}: Route.HeadersArgs) {
  const out = new Headers();
  for (const name of ['Cache-Control', 'Set-Cookie']) {
    for (const v of name === 'Set-Cookie' ? loaderHeaders.getSetCookie() : [loaderHeaders.get(name)]) if (v) out.append(name, v);
  }
  return out;
}

type Row = {id: string; name: string; bucket: number};

/** Published regions as list rows: biggest bucket first, then by name; the pools last. */
function rowsOf(snapshot: Snapshot, pick: (region: string) => string | null, pool: string, poolName: string): Row[] {
  const rows: Row[] = [];
  for (const [region, bucket] of Object.entries(snapshot.regions)) {
    const name = pick(region);
    if (name) rows.push({id: region, name, bucket});
  }
  rows.sort((a, b) => b.bucket - a.bucket || a.name.localeCompare(b.name, 'en'));
  const pooled = snapshot.regions[pool];
  return pooled === undefined ? rows : [...rows, {id: pool, name: poolName, bucket: pooled}];
}

function RegionList({id, title, rows}: {id: string; title: string; rows: Row[]}) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby={id} className="owners-list">
      <h3 id={id} className="owners-list-title">
        {title}
      </h3>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <span>{row.name}</span>
            <span className="owners-list-range">
              {bucketLabel(row.bucket)} {copyText('owners.list_range') ?? 'owners'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function monthOf(ms: number): string {
  return new Date(ms).toLocaleDateString('en', {month: 'long', year: 'numeric', timeZone: 'UTC'});
}

export default function OwnersRoute({loaderData}: Route.ComponentProps) {
  const {snapshot, fixture, pilot, notice} = loaderData;
  const hasRegions = snapshot !== null && Object.keys(snapshot.regions).length > 0;

  const countries = snapshot
    ? rowsOf(
        snapshot,
        (r) => (/^[A-Z]{2}$/.test(r) ? countryName(r) : null),
        OTHER_COUNTRIES,
        copyText('owners.other_countries') ?? 'Other countries',
      )
    : [];
  const states = snapshot
    ? rowsOf(
        snapshot,
        (r) => (r.startsWith('US-') && STATE_NAME[r.slice(3)] ? STATE_NAME[r.slice(3)]! : null),
        OTHER_US_STATES,
        copyText('owners.other_us_states') ?? 'Other US states',
      )
    : [];

  return (
    <EditorialShell slug="owners" rail={false} reveal={false} pageClassName="owners-page">
      <header className="editorial-hero">
        <Txt id="owners.eyebrow" as="p" className="editorial-eyebrow" />
        <Txt id="owners.title" as="h1" className="editorial-title" />
        <Txt id="owners.lead" as="p" className="editorial-lead" />
      </header>

      {snapshot && snapshot.total !== null ? (
        <dl className="owners-stats">
          <div>
            <dt>{copyText('owners.stat_owners_label') ?? 'owners'}</dt>
            <dd {...editAttrs('owners.stat_owners')}>
              {copyFill('owners.stat_owners', '{n}+', {n: snapshot.total.toLocaleString('en')})}
            </dd>
          </div>
          <div>
            <dt>{copyText('owners.stat_countries_label') ?? 'countries'}</dt>
            <dd {...editAttrs('owners.stat_countries')}>
              {copyFill('owners.stat_countries', '{n}', {n: snapshot.countries.toLocaleString('en')})}
            </dd>
          </div>
        </dl>
      ) : null}

      {snapshot && hasRegions ? (
        <section className="owners-map-section" aria-labelledby="owners-map-title">
          <h2 id="owners-map-title" className="editorial-section-title">
            <Txt id="owners.map_title" />
          </h2>
          <OwnerMap snapshot={snapshot} />
          <p className="owners-meta">
            {fixture
              ? copyText('owners.fixture_note')
              : copyFill('owners.updated', 'Updated {month}.', {month: monthOf(snapshot.generatedAt)})}
          </p>
          <div className="owners-lists">
            <h2 className="editorial-section-title">
              <Txt id="owners.list_title" />
            </h2>
            <div className="owners-lists-grid">
              <RegionList id="owners-list-countries" title={copyText('owners.list_countries') ?? 'Countries'} rows={countries} />
              <RegionList id="owners-list-states" title={copyText('owners.list_states') ?? 'United States by state'} rows={states} />
            </div>
          </div>
        </section>
      ) : (
        <Txt id="owners.empty" as="p" className="owners-empty" />
      )}

      <section className="editorial-section owners-how">
        <Txt id="owners.how_title" as="h2" className="editorial-section-title" />
        <Txt id="owners.how_body" as="p" />
      </section>

      {pilot.enabled ? <PilotMap panel={pilot} notice={notice} /> : null}
    </EditorialShell>
  );
}
