import {data} from 'react-router';
import type {Route} from './+types/owners';
import {OwnersMap} from '~/components/OwnersMap';
import {pilotNotice} from '~/components/OwnersPilot';
import {copyText} from '~/lib/copy';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {countryName, STATE_NAME} from '~/lib/owner-map-geo';
import {loadOwnerMap, ownerMapFixture} from '~/lib/owner-map-data';
import {pilotPanel} from '~/lib/pilot-map-server';
import {publicSnapshot, type PublicSnapshot} from '~/lib/owner-map';

/**
 * The public owners map: which countries and US states have owners, never
 * how many (app/lib/owner-map.ts holds the suppression rules, README
 * "Owners map" the whole feature). The loader sends names-free ids, shading
 * levels, a milestone and a country floor, and no other number. Words live in `content/copy/owners.json`.
 *
 * The page is one map (app/components/OwnersMap.tsx) under one card; the
 * opt-in pilot map (app/components/OwnersPilot.tsx) lives in that card and on
 * that map while PILOT_MAP_ENABLED is "1". What a viewer may see of it is decided in
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
  const body = {snapshot: publicSnapshot(await loadOwnerMap(env)), fixture: ownerMapFixture(env), pilot: panel, notice: panel.enabled ? notice : null};
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

type Row = {id: string; name: string};

/** Published regions as list rows: names only, alphabetical. */
function rowsOf(snapshot: PublicSnapshot, pick: (region: string) => string | null): Row[] {
  const rows: Row[] = [];
  for (const region of Object.keys(snapshot.regions)) {
    const name = pick(region);
    if (name) rows.push({id: region, name});
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return rows;
}

function RegionList({id, title, rows}: {id: string; title: string; rows: Row[]}) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>{row.name}</li>
        ))}
      </ul>
    </section>
  );
}

export default function OwnersRoute({loaderData}: Route.ComponentProps) {
  const {snapshot, fixture, pilot, notice} = loaderData;

  const countries = snapshot
    ? rowsOf(snapshot, (r) => (/^[A-Z]{2}$/.test(r) ? countryName(r) : null))
    : [];
  const states = snapshot
    ? rowsOf(snapshot, (r) => (r.startsWith('US-') && STATE_NAME[r.slice(3)] ? STATE_NAME[r.slice(3)]! : null))
    : [];

  return (
    <OwnersMap snapshot={snapshot} fixture={fixture} panel={pilot.enabled ? pilot : null} notice={notice}>
      <div className="sr-only">
        <RegionList id="owners-list-countries" title={copyText('owners.list_countries') ?? 'Countries'} rows={countries} />
        <RegionList id="owners-list-states" title={copyText('owners.list_states') ?? 'United States by state'} rows={states} />
      </div>
    </OwnersMap>
  );
}
