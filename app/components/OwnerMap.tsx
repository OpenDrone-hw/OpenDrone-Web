import {useEffect, useMemo, useState, type PointerEvent} from 'react';
import {geoContains, geoNaturalEarth1, geoPath} from 'd3-geo';
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

export const WIDTH = 960;
const ANTARCTICA = '010';

/** The framings the map offers. Most owners are in Europe and the US, so the world view is one tab, not the default. */
export type MapRegion = 'both' | 'europe' | 'us' | 'world';
export const MAP_REGIONS: readonly MapRegion[] = ['both', 'europe', 'us', 'world'];
export type MapSize = {w: number; h: number};

/** lon min, lat min, lon max, lat max */
const BOXES: Record<Exclude<MapRegion, 'world'>, [number, number, number, number]> = {
  both: [-128, 24, 42, 71],
  europe: [-11, 34, 35, 71],
  us: [-126, 24, -66, 50],
};

/** True on a phone-width viewport. False until mounted, which is before the map geometry arrives. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(max-width: 640px)');
    const sync = () => setNarrow(q.matches);
    sync();
    q.addEventListener('change', sync);
    return () => q.removeEventListener('change', sync);
  }, []);
  return narrow;
}

/** Box of the SVG: taller on a phone so countries stay readable; the pilot map is taller than the public one. */
export const mapSize = (narrow: boolean, tall: boolean): MapSize => ({
  w: WIDTH,
  h: narrow ? (tall ? 1040 : 720) : tall ? 600 : 500,
});

/** Framing state: null until the viewer picks one, then the default for the viewport applies. */
export function useMapRegion(narrow: boolean) {
  const [picked, setPicked] = useState<MapRegion | null>(null);
  return [picked ?? "europe", setPicked] as const;
}

type Shape = {
  /** Stable key: country code, `US-CA`, or a name for a shape without a code. */
  key: string;
  /** Snapshot region this shape is coloured by, or null. */
  region: string | null;
  name: string;
  d: string;
};

export type Geo = {countries: Topology; states: Topology};

type CountryProps = {name: string};

/** Fetch both boundary files once per page view. */
export function useGeo(): {geo: Geo | null; failed: boolean} {
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

/** Points along the edge of a lon/lat box, so the fit follows the box and not just its corners. */
function boxPoints([x0, y0, x1, y1]: [number, number, number, number]): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = x0; x <= x1; x += 3) pts.push([x, y0], [x, y1]);
  for (let y = y0; y <= y1; y += 3) pts.push([x0, y], [x1, y]);
  return pts;
}

/** Countries without Antarctica, and the projection that fits the chosen framing to the map box. Shared with the pilot map. */
export function worldProjection(geo: Geo, size: MapSize, region: MapRegion) {
  const countryFeatures = feature(geo.countries, geo.countries.objects.countries as GeometryCollection<CountryProps>).features.filter(
    (f) => f.id !== ANTARCTICA,
  );
  const target =
    region === 'world'
      ? ({type: 'FeatureCollection', features: countryFeatures} as const)
      : ({type: 'MultiPoint', coordinates: boxPoints(BOXES[region])} as const);
  const projection = geoNaturalEarth1().fitExtent(
    [
      [4, 4],
      [size.w - 4, size.h - 4],
    ],
    target,
  );
  return {countryFeatures, projection};
}

/** "Texas, United States" or "Germany" for a point, from the boundaries already loaded; null over open sea. */
export function placeAt(geo: Geo, lat: number, lon: number): string | null {
  const point: [number, number] = [lon, lat];
  const countries = feature(geo.countries, geo.countries.objects.countries as GeometryCollection<CountryProps>).features;
  const hit = countries.find((f) => f.id !== ANTARCTICA && geoContains(f, point));
  if (!hit) return null;
  const code = (hit.id !== undefined ? COUNTRY_BY_NUMERIC[String(hit.id)] : undefined) ?? COUNTRY_BY_NAME[hit.properties.name] ?? null;
  const country = code ? countryName(code) : hit.properties.name;
  if (code === 'US') {
    const states = feature(geo.states, geo.states.objects.states as GeometryCollection<CountryProps>).features;
    const st = states.find((f) => geoContains(f, point));
    const name = st ? STATE_NAME[STATE_BY_FIPS[String(st.id)] ?? ''] : undefined;
    if (name) return `${name}, ${country}`;
  }
  return country;
}

/** Tabs that switch the framing. */
export function RegionTabs({value, onChange}: {value: MapRegion; onChange: (r: MapRegion) => void}) {
  return (
    <div className="owner-map-tabs" role="group" aria-label={copyText('owners.region_label') ?? 'Map view'}>
      {MAP_REGIONS.map((r) => (
        <button
          key={r}
          type="button"
          className="owner-map-tab"
          aria-pressed={value === r}
          onClick={() => onChange(r)}
        >
          {copyText(`owners.region_${r}`) ?? r}
        </button>
      ))}
    </div>
  );
}

/** Project every shape to an SVG path. The United States is drawn by state when it is published. */
function buildShapes(geo: Geo, drawStates: boolean, size: MapSize, region: MapRegion): Shape[] {
  const {countryFeatures, projection} = worldProjection(geo, size, region);
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
  const narrow = useNarrow();
  const [region, setRegion] = useMapRegion(narrow);
  const size = mapSize(narrow, false);
  const shapes = useMemo(
    () => (geo ? buildShapes(geo, drawStates, size, region) : []),
    [geo, drawStates, size.w, size.h, region],
  );
  const [active, setActive] = useState<string | null>(null);

  const byKey = useMemo(() => new Map(shapes.map((s) => [s.key, s])), [shapes]);
  const current = active ? byKey.get(active) : undefined;

  function pick(event: PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) {
    const key = (event.target as Element).closest('[data-key]')?.getAttribute('data-key');
    if (key) setActive(key);
  }

  return (
    <figure className="owner-map">
      <RegionTabs value={region} onChange={setRegion} />
      <div className="owner-map-frame">
        {shapes.length ? (
          <svg
            className="owner-map-svg"
            viewBox={`0 0 ${size.w} ${size.h}`}
            style={{aspectRatio: `${size.w} / ${size.h}`}}
            role="img"
            aria-label={copyText('owners.map_aria') ?? 'Map of OpenDrone owners by region'}
            onPointerOver={pick}
            onClick={pick}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          >
            {[...shapes.filter((s) => s.key !== active), ...shapes.filter((s) => s.key === active)].map((s) => {
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
          <p className="owner-map-status" style={{aspectRatio: `${size.w} / ${size.h}`}}>
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
