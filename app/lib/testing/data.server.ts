import {previewFigure} from './decimate.ts';
import {unitLabel} from './scale.ts';
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

export type Tile = {id: string; label: string; value: string; unit: string; sub: string; note: string};

/** Figures whose last point of the longest run is a headline number, in order. */
const TILE_FIGURES = ['openmotor-hold-thrust', 'openmotor-hold-rpm', 'openmotor-hold-esc-temp', 'openmotor-hold-pack-voltage'];

const round = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));

/** What each number is, so no tile is a floating number. Wording that states a limit lives here, beside the number. */
function noteOf(id: string, value: number, setup: string[]): string {
  const pairs = setup.join(' ').match(/(\d+) pole pairs/)?.[1];
  const cal = setup.join(' ').match(/(\d+ g) reference mass.*?about ([\d.]+) percent/);
  switch (id) {
    case 'openmotor-hold-thrust':
      return `Load cell${cal ? `, calibrated at one point, ${cal[1]}, about ${cal[2]} percent` : ''}`;
    case 'openmotor-hold-rpm':
      return pairs ? `ESC eRPM ${Math.round(value * Number(pairs))} over ${pairs} pole pairs, assumed` : 'ESC eRPM over an assumed pole count';
    case 'openmotor-hold-esc-temp':
      return 'Hottest of 4 die sensors, only channel 1 driven';
    case 'openmotor-hold-pack-voltage':
      return 'ESC reading, not checked against a meter';
    default:
      return '';
  }
}

/** The tile title: the quantity, with the condition that limits it when the quantity alone would mislead. */
const TILE_LABEL: Record<string, string> = {
  'openmotor-hold-pack-voltage': 'Pack voltage under load',
};

/**
 * Headline numbers for the top of the page, read from the figure files: the
 * last hold of the run that went furthest, with the throttle it was taken at.
 * Each is a hold median, not a peak. A rotor speed of five digits is written
 * in thousands, to the precision its assumed pole count supports.
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
    const kilo = fig.axes.y.unit === 'rpm' && last >= 10000;
    out.push({
      id,
      label: TILE_LABEL[id] ?? fig.axes.y.label.replace(/\s*\(.*?\)/g, ''),
      value: kilo ? round(last / 1000) : round(last),
      unit: kilo ? 'krpm' : unitLabel(fig.axes.y.unit),
      sub: `${series.label.replace(/, hold median.*$/, '').replace(/, ends at.*$/, '')}, ${x} ${fig.axes.x.unit} throttle hold`,
      note: noteOf(id, last, index.runs[sum.runId]?.setup ?? []),
    });
  }
  return out;
}
