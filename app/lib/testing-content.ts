/**
 * Bench evidence for the /testing page and the product Testing chapters.
 *
 * The JSON under `content/testing/` is written by `scripts/sync-testing.mjs`
 * from the bench app plus a hand-written config. This loader is the second
 * line of the honesty gate: whatever is on disk, it never returns a figure
 * that is not marked `publish`, is simulated, or plots a current or power
 * field from the thrust stand (whose current sense is not calibrated).
 */

export type Point = [number, number];

export type AxisSpec = {
  label: string;
  unit: string;
  scale: 'linear' | 'log';
  min?: number;
  max?: number;
};

export type Series = {
  id: string;
  name: string;
  role: 'measured' | 'reference';
  style: 'solid' | 'dashed' | 'points';
  field?: string;
  axis?: 'y2';
  points: Point[];
  band?: {lo: Point[]; hi: Point[]};
};

export type Figure = {
  id: string;
  product: string;
  tier: string | null;
  title: string;
  kind: 'line' | 'scatter' | 'band';
  featured: boolean;
  order: number;
  blurb?: string;
  group?: string;
  x: AxisSpec;
  y: AxisSpec;
  y2?: AxisSpec;
  series: Series[];
  setup: string;
  source: {
    run: string;
    kind: string;
    recorded: string;
    simulated: boolean;
    reduction: string;
  };
  finding: string;
  caveats: string[];
  status: 'publish' | 'needs-review';
};

export type TimelineItem = {
  id: string;
  date: string;
  product: string;
  tested: string;
  saw: string;
  changed: string | null;
  figureId?: string;
  commit?: string;
  status: 'publish' | 'needs-review';
};

/** Current and power fields that must never be plotted from a drv-04 run. */
const BANNED_FIELD = /^(i_a|i_raw|i_shunt|i_clamp|p_shunt|eff_gw|clamp_a)$|power|gw/i;
const THRUST_STAND_RUN = /^drv-04-/;

const FILES = import.meta.env
  ? import.meta.glob<{default: unknown}>('/content/testing/*.json', {
      eager: true,
    })
  : {};

function load<T>(name: string): T | undefined {
  for (const [path, mod] of Object.entries(FILES)) {
    if (path.endsWith(`/${name}.json`)) return mod.default as T;
  }
  return undefined;
}

/** True when the figure may be shown. Exported for the tests. */
export function figureAllowed(f: Figure): boolean {
  if (f.status !== 'publish') return false;
  if (f.source?.simulated === true) return false;
  const thrustStand =
    THRUST_STAND_RUN.test(f.source?.run ?? '') ||
    f.source?.kind === 'thrust-stand';
  if (thrustStand) {
    for (const s of f.series) {
      if (s.field && BANNED_FIELD.test(s.field)) return false;
    }
    if (BANNED_FIELD.test(f.y.label) || BANNED_FIELD.test(f.y.unit)) return false;
    if (f.y2 && (BANNED_FIELD.test(f.y2.label) || /^(w|a)$/i.test(f.y2.unit))) {
      return false;
    }
    if (/^(a|w)$/i.test(f.y.unit)) return false;
  }
  return true;
}

export function itemAllowed(i: TimelineItem): boolean {
  return i.status === 'publish';
}

const ALL_FIGURES: Figure[] = (
  load<{figures?: Figure[]}>('figures')?.figures ?? []
).filter(figureAllowed);

const ALL_ITEMS: TimelineItem[] = (
  load<{items?: TimelineItem[]}>('timeline')?.items ?? []
).filter(itemAllowed);

/** Build the accessor set over explicit data, so tests can feed their own. */
export function makeTesting(figures: Figure[], items: TimelineItem[]) {
  const okFigures = figures.filter(figureAllowed);
  const okItems = items.filter(itemAllowed);
  const byOrder = (a: Figure, b: Figure) => a.order - b.order;
  return {
    getFigures(product: string): Figure[] {
      return okFigures.filter((f) => f.product === product).sort(byOrder);
    },
    getFeatured(product: string, tier?: string | null): Figure | null {
      const own = okFigures.filter((f) => f.product === product && f.featured);
      if (own.length === 0) return null;
      const t = normalizeTier(tier);
      // A tiered figure shows only on its own tier. Untiered figures always show.
      const hit = own.find(
        (f) => !f.tier || !t || normalizeTier(f.tier) === t,
      );
      return hit ?? null;
    },
    getTimeline(product?: string): TimelineItem[] {
      return okItems
        .filter((i) => !product || i.product === product)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    },
    productsWithData(): string[] {
      return [...new Set(okFigures.map((f) => f.product))];
    },
  };
}

/** `20×20`, `20x20` and `20X20` all compare equal. */
export function normalizeTier(t: string | null | undefined): string | null {
  if (!t) return null;
  return t.toLowerCase().replace(/[×x]/g, 'x').trim();
}

const api = makeTesting(ALL_FIGURES, ALL_ITEMS);

export const getFigures = api.getFigures;
export const getFeatured = api.getFeatured;
export const getTimeline = api.getTimeline;
export const productsWithData = api.productsWithData;
export function getFigure(id: string): Figure | undefined {
  return ALL_FIGURES.find((f) => f.id === id);
}
