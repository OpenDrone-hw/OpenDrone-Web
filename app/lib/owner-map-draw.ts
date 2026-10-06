import {geoContains, geoNaturalEarth1, geoPath} from 'd3-geo';
import {feature} from 'topojson-client';
import type {GeometryCollection, Topology} from 'topojson-specification';
import {
  COUNTRY_BY_NAME,
  COUNTRY_BY_NUMERIC,
  STATE_BY_FIPS,
  STATE_NAME,
  countryName,
} from '~/lib/owner-map-geo';

/**
 * Geometry for the owners map (README "Owners map"): countries from
 * `public/geo/countries-50m.json` (Natural Earth, public domain, through
 * world-atlas) and the United States by state from `public/geo/states-10m.json`
 * (US Census, through us-atlas). Both are static files on this origin.
 */

export type Geo = {countries: Topology; states: Topology};
type Props = {name: string};

/** lon min, lat min, lon max, lat max: the default framing, the whole inhabited world. */
const WORLD: [number, number, number, number] = [-180, -56, 180, 83];
const ANTARCTICA = '010';

export type Shape = {
  /** Stable key: country code, `US-CA`, or a name for a shape without a code. */
  key: string;
  /** Snapshot region this shape is coloured by, or null. */
  region: string | null;
  name: string;
  d: string;
};

const countryFeatures = (geo: Geo) =>
  feature(
    geo.countries,
    geo.countries.objects.countries as GeometryCollection<Props>,
  ).features.filter((f) => f.id !== ANTARCTICA);

const codeOf = (f: {id?: string | number; properties: Props}): string | null =>
  (f.id !== undefined ? COUNTRY_BY_NUMERIC[String(f.id)] : undefined) ??
  COUNTRY_BY_NAME[f.properties.name] ??
  null;

/** Points along the edge of a lon/lat box, so the fit follows the box and not just its corners. */
function boxPoints([x0, y0, x1, y1]: [number, number, number, number]): [
  number,
  number,
][] {
  const pts: [number, number][] = [];
  for (let x = x0; x <= x1; x += 3) pts.push([x, y0], [x, y1]);
  for (let y = y0; y <= y1; y += 3) pts.push([x0, y], [x1, y]);
  return pts;
}

/** Natural Earth projection that fits the world into `frame` (left, top, right, bottom in pixels). */
export function projectionFor(frame: [number, number, number, number]) {
  const [l, t, r, b] = frame;
  return geoNaturalEarth1().fitExtent(
    [
      [l, t],
      [r, b],
    ],
    {type: 'MultiPoint', coordinates: boxPoints(WORLD)},
  );
}

export type Drawn = {
  shapes: Shape[];
  projection: ReturnType<typeof projectionFor>;
  bounds: [[number, number], [number, number]];
};

/** Project every shape to an SVG path. The United States is drawn by state when it is published. */
export function drawWorld(
  geo: Geo,
  drawStates: boolean,
  frame: [number, number, number, number],
): Drawn {
  const projection = projectionFor(frame);
  const path = geoPath(projection);
  const shapes: Shape[] = [];
  const used = new Set<string>();
  const all = countryFeatures(geo);
  for (const f of all) {
    const code = codeOf(f);
    if (code === 'US' && drawStates) continue;
    const d = path(f);
    if (!d) continue;
    // Two features can share a code (outlying islands): keep both drawn, keep keys unique.
    const base = code ?? `name:${f.properties.name}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}#${n}`;
    used.add(key);
    shapes.push({
      key,
      region: code,
      name: code ? countryName(code) : f.properties.name,
      d,
    });
  }
  if (drawStates) {
    const states = feature(
      geo.states,
      geo.states.objects.states as GeometryCollection<Props>,
    ).features;
    for (const f of states) {
      const code = STATE_BY_FIPS[String(f.id)];
      const d = code ? path(f) : null;
      if (code && d)
        shapes.push({
          key: `US-${code}`,
          region: `US-${code}`,
          name: STATE_NAME[code] ?? code,
          d,
        });
    }
  }
  const bounds = geoPath(projection).bounds({
    type: 'FeatureCollection',
    features: all,
  });
  return {shapes, projection, bounds};
}

/** "Texas, United States" or "Germany" for a point, from the boundaries already loaded; null over open sea. */
export function placeAt(geo: Geo, lat: number, lon: number): string | null {
  const point: [number, number] = [lon, lat];
  const hit = countryFeatures(geo).find((f) => geoContains(f, point));
  if (!hit) return null;
  const code = codeOf(hit);
  const country = code ? countryName(code) : hit.properties.name;
  if (code === 'US') {
    const states = feature(
      geo.states,
      geo.states.objects.states as GeometryCollection<Props>,
    ).features;
    const st = states.find((f) => geoContains(f, point));
    const name = st
      ? STATE_NAME[STATE_BY_FIPS[String(st.id)] ?? '']
      : undefined;
    if (name) return `${name}, ${country}`;
  }
  return country;
}
