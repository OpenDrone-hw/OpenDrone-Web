import {previewFigure} from './decimate.ts';
import {featuredIds} from './select.ts';
import type {Fig, TestingIndex} from './types.ts';

/**
 * Reads the files `npm run sync:testing` wrote to `public/testing/`. Only a
 * route loader imports this: the `.server` suffix keeps it, and the figure data
 * it bundles, out of the browser build. The browser fetches single figures from
 * `/testing/fig/<id>.json` instead.
 */

const FILES: Record<string, {default: unknown}> = import.meta.env
  ? import.meta.glob('/public/testing/**/*.json', {eager: true})
  : {};

function load<T>(path: string): T | undefined {
  const hit = FILES[`/public/testing/${path}`];
  return hit?.default as T | undefined;
}

const EMPTY: TestingIndex = {products: [], runs: {}, figures: {}, log: [], built: ''};

export function getIndex(): TestingIndex {
  return load<TestingIndex>('index.json') ?? EMPTY;
}

export function getFigure(id: string): Fig | undefined {
  return load<Fig>(`fig/${id}.json`);
}

/** Every figure thinned for server-rendered SVG, keyed by id. */
export function getPreviews(maxPoints: number, ids?: string[]): Record<string, Fig> {
  const index = getIndex();
  const out: Record<string, Fig> = {};
  for (const id of ids ?? Object.keys(index.figures)) {
    const fig = getFigure(id);
    if (fig) out[id] = previewFigure(fig, maxPoints);
  }
  return out;
}

/** Cards for a product page: its featured figures, thinned, with run and chip. */
export function getProductCards(handle: string) {
  const index = getIndex();
  const ids = featuredIds(index, handle);
  const previews = getPreviews(160, ids);
  return ids
    .filter((id) => previews[id])
    .map((id) => ({
      id,
      summary: index.figures[id]!,
      date: index.runs[index.figures[id]!.runId]?.date ?? '',
      state:
        index.runs[index.figures[id]!.runId]?.setup
          .find((l) => l.startsWith('Run state:'))
          ?.replace(/^Run state: /, '')
          .replace(/\.$/, '') ?? null,
      fig: previews[id]!,
    }));
}
export type ProductCard = ReturnType<typeof getProductCards>[number];

export type Tile = {id: string; label: string; value: string; unit: string; sub: string};

/** Figures whose last point of the longest run is a headline number, in order. */
const TILE_FIGURES = ['openmotor-hold-thrust', 'openmotor-hold-rpm', 'openmotor-hold-esc-temp', 'openmotor-hold-pack-voltage'];

const round = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));

/**
 * Headline numbers for the top of the page, read from the figure files: the
 * last hold of the run that went furthest, with the throttle it was taken at.
 */
export function getTiles(): Tile[] {
  const index = getIndex();
  const out: Tile[] = [];
  for (const id of TILE_FIGURES) {
    const fig = getFigure(id);
    const sum = index.figures[id];
    if (!fig || !sum) continue;
    const series = fig.series
      .filter((s) => s.kind === 'hold' && s.x.length)
      .sort((a, b) => b.x[b.x.length - 1]! - a.x[a.x.length - 1]!)[0];
    if (!series) continue;
    const last = series.y[series.y.length - 1];
    if (last === null || last === undefined) continue;
    const x = series.x[series.x.length - 1];
    out.push({
      id,
      label: fig.axes.y.label.replace(/\s*\(.*?\)/g, ''),
      value: round(last),
      unit: fig.axes.y.unit === 'degC' ? '°C' : fig.axes.y.unit,
      sub: `${x} ${fig.axes.x.unit} throttle, run ${series.pack ?? sum.runId}`,
    });
  }
  return out;
}
