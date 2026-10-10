import type {Fig, FigSummary, TestingIndex} from './types.ts';

/** `20×20`, `20x20` and `20X20` all compare equal. */
export function normalizeTier(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.toLowerCase().replace(/[×x]/g, 'x').trim();
}

export type FeaturedPick = {id: string} & FigSummary;

/**
 * The featured figure of a product for a tier. A tiered figure shows only on
 * its own tier; an untiered one always shows. Reads the index only, so a
 * product page needs no figure file.
 */
export function pickFeatured(
  index: TestingIndex,
  handle: string,
  tier?: string | null,
): FeaturedPick | null {
  const own = Object.entries(index.figures)
    .filter(([, f]) => f.product === handle && f.featured)
    .map(([id, f]) => ({id, ...f}))
    .sort((a, b) => a.order - b.order);
  const t = normalizeTier(tier);
  return own.find((f) => !f.tier || !t || normalizeTier(f.tier) === t) ?? null;
}

export function featuredIds(index: TestingIndex, handle: string): string[] {
  return Object.entries(index.figures)
    .filter(([, f]) => f.product === handle && f.featured)
    .map(([id]) => id);
}

export type Summary = {products: number; figures: number; runs: number; lastRun: string};

export function summarize(index: TestingIndex): Summary {
  const dates = Object.values(index.runs)
    .map((r) => r.date)
    .sort();
  return {
    products: index.products.length,
    figures: Object.keys(index.figures).length,
    runs: Object.keys(index.runs).length,
    lastRun: dates[dates.length - 1] ?? '',
  };
}

const holdOnly = (f: Fig) => f.series.length > 0 && f.series.every((s) => s.kind === 'hold');

export type Block = {kind: 'card'; id: string} | {kind: 'stack'; ids: string[]};

/**
 * Figures of one run that share an x axis and are all hold figures become one
 * stacked card; every other figure stays a card of its own.
 */
export function blocksOf(ids: string[], index: TestingIndex, previews: Record<string, Fig>): Block[] {
  const key = (id: string) => {
    const f = previews[id]!;
    return holdOnly(f) ? `${index.figures[id]!.runId}|${f.axes.x.label}|${f.axes.x.unit}` : null;
  };
  const count = new Map<string, number>();
  for (const id of ids) {
    const k = key(id);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const out: Block[] = [];
  const done = new Set<string>();
  for (const id of ids) {
    const k = key(id);
    if (k && (count.get(k) ?? 0) > 1) {
      if (done.has(k)) continue;
      done.add(k);
      out.push({kind: 'stack', ids: ids.filter((i) => key(i) === k)});
    } else out.push({kind: 'card', id});
  }
  return out;
}

