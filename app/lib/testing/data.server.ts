import {previewFigure} from './decimate.ts';
import {featuredIds} from './select.ts';
import {numberFigures} from './layout.ts';
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
  const all = numberFigures(index, (id) => Boolean(getFigure(id)));
  return ids
    .filter((id) => previews[id])
    .map((id) => ({
      id,
      /** The figure's number in the test report, which the card links to. */
      no: all.find((n) => n.id === (index.figures[id]!.duplicateOf ?? id))?.no ?? null,
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
