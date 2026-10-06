import {useEffect, useMemo, useState, type PointerEvent} from 'react';
import {geoNaturalEarth1, geoPath} from 'd3-geo';
import {feature} from 'topojson-client';
import type {GeometryCollection, Topology} from 'topojson-specification';
import {copyFill, copyText} from '~/lib/copy';
import {
  COUNTRY_BY_NAME,
  COUNTRY_BY_NUMERIC,
  STATE_BY_FIPS,
  STATE_NAME,
  countryName,
} from '~/lib/owner-map-geo';
import {BUCKET_COUNT, bucketLabel, type Snapshot} from '~/lib/owner-map';

/**
 * The owners choropleth (README "Owners map"): countries from
 * `public/geo/countries-110m.json` (Natural Earth, public domain, through
 * world-atlas), the United States drawn by state from
 * `public/geo/states-10m.json` (US Census, through us-atlas). Both are static
 * files on this origin, so the map makes no third-party request and the CSP
 * is unchanged. The geometry is fetched after hydration and drawn as SVG;
 * the list of published regions under it carries the same figures as text.
 *
 * Colour comes from CSS (`.owner-map-region[data-b]`), so the ramp follows
 * the light and dark theme. A region without a bucket is neutral: it is
 * unpublished, which is not the same as zero owners.
 */

const WIDTH = 960;
const HEIGHT = 500;
const ANTARCTICA = '010';

type Shape = {
  /** Stable key: country code, `US-CA`, or a name for a shape without a code. */
  key: string;
  /** Snapshot region this shape is coloured by, or null. */
  region: string | null;
  name: string;
  d: string;
};

type Geo = {countries: Topology; states: Topology};

type CountryProps = {name: string};

/** Fetch both boundary files once per page view. */
function useGeo(): {geo: Geo | null; failed: boolean} {
  const [state, setState] = useState<{geo: Geo | null; failed: boolean}>({geo: null, failed: false});
  useEffect(() => {
    let live = true;
    const load = (file: string): Promise<Topology> =>
      fetch(`/geo/${file}`).then((r) => (r.ok ? (r.json() as Promise<Topology>) : Promise.reject(new Error(file))));
    Promise.all([load('countries-110m.json'), load('states-10m.json')]).then(
      ([countries, states]) => live && setState({geo: {countries, states}, failed: false}),
      () => live && setState({geo: null, failed: true}),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Project every shape to an SVG path. The United States is drawn by state when it is published. */
function buildShapes(geo: Geo, drawStates: boolean): Shape[] {
  const countryFeatures = (
    feature(geo.countries, geo.countries.objects.countries as GeometryCollection<CountryProps>)
  ).features.filter((f) => f.id !== ANTARCTICA);
  const projection = geoNaturalEarth1().fitExtent(
    [
      [4, 4],
      [WIDTH - 4, HEIGHT - 4],
    ],
    {type: 'FeatureCollection', features: countryFeatures},
  );
  const path = geoPath(projection);
  const shapes: Shape[] = [];

  for (const f of countryFeatures) {
    const code = (f.id !== undefined ? COUNTRY_BY_NUMERIC[String(f.id)] : undefined) ?? COUNTRY_BY_NAME[f.properties.name] ?? null;
    if (code === 'US' && drawStates) continue;
    const d = path(f);
    if (!d) continue;
    shapes.push({key: code ?? `name:${f.properties.name}`, region: code, name: code ? countryName(code) : f.properties.name, d});
  }

  if (drawStates) {
    const states = feature(geo.states, geo.states.objects.states as GeometryCollection<CountryProps>).features;
    for (const f of states) {
      const code = STATE_BY_FIPS[String(f.id)];
      if (!code) continue;
      const d = path(f);
      if (d) shapes.push({key: `US-${code}`, region: `US-${code}`, name: STATE_NAME[code] ?? code, d});
    }
  }
  return shapes;
}

function readoutFor(shape: Shape, snapshot: Snapshot): string {
  const bucket = shape.region === null ? undefined : snapshot.regions[shape.region];
  if (bucket !== undefined) {
    return copyFill('owners.readout_owners', '{name}: {range} owners', {name: shape.name, range: bucketLabel(bucket)});
  }
  return copyFill('owners.readout_unpublished', '{name}: not published, fewer than 5 owners', {name: shape.name});
}

export function OwnerMap({snapshot}: {snapshot: Snapshot}) {
  const {geo, failed} = useGeo();
  const drawStates = snapshot.regions.US !== undefined;
  const shapes = useMemo(() => (geo ? buildShapes(geo, drawStates) : []), [geo, drawStates]);
  const [active, setActive] = useState<string | null>(null);

  const byKey = useMemo(() => new Map(shapes.map((s) => [s.key, s])), [shapes]);
  const current = active ? byKey.get(active) : undefined;

  function pick(event: PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) {
    const key = (event.target as Element).closest('[data-key]')?.getAttribute('data-key');
    if (key) setActive(key);
  }

  return (
    <figure className="owner-map">
      <div className="owner-map-frame">
        {shapes.length ? (
          <svg
            className="owner-map-svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label={copyText('owners.map_aria') ?? 'Map of OpenDrone owners by region'}
            onPointerOver={pick}
            onClick={pick}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          >
            {shapes.map((s) => {
              const bucket = s.region === null ? undefined : snapshot.regions[s.region];
              return (
                <path
                  key={s.key}
                  d={s.d}
                  data-key={s.key}
                  data-b={bucket}
                  className={`owner-map-region${active === s.key ? ' is-active' : ''}`}
                />
              );
            })}
          </svg>
        ) : (
          <p className="owner-map-status">
            {failed
              ? (copyText('owners.map_failed') ?? 'The map could not be loaded.')
              : (copyText('owners.map_loading') ?? 'Loading the map')}
          </p>
        )}
        <p className="owner-map-readout" aria-hidden="true">
          {current ? readoutFor(current, snapshot) : (copyText('owners.hint') ?? 'Hover or tap a region.')}
        </p>
      </div>
      <Legend />
    </figure>
  );
}

/** The bucket ramp as swatches, plus the neutral "not published". */
function Legend() {
  return (
    <figcaption className="owner-map-legend">
      <span className="owner-map-legend-title">{copyText('owners.legend_title') ?? 'Owners per region'}</span>
      <ul>
        {Array.from({length: BUCKET_COUNT}, (_, b) => (
          <li key={b}>
            <span className="owner-map-swatch" data-b={b} aria-hidden="true" />
            {bucketLabel(b)}
          </li>
        ))}
        <li>
          <span className="owner-map-swatch" aria-hidden="true" />
          {copyText('owners.legend_unpublished') ?? 'Not published'}
        </li>
      </ul>
    </figcaption>
  );
}
