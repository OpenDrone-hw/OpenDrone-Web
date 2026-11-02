/**
 * The cart's mismatch alert: runs the rules in `cart-compat-data.ts` over the
 * SKUs in the cart and words each conflict with its fix. Advisory only: it
 * never blocks checkout.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {
  COMPAT_LOCALES,
  COMPAT_PARTS,
  COMPAT_RULES,
  COMPAT_UI,
  SUB_GHZ_BY_COUNTRY,
  type Band,
  type CompatLocale,
  type CompatPart,
  type CompatRule,
} from './cart-compat-data.ts';

export type CompatConflict = {
  rule: string;
  a: string;
  /** The partner SKU, or the buyer's country for a region rule. */
  b: string;
  aValue: string;
  bValue: string;
  /** A SKU that fixes the conflict when swapped in, if the data knows one. */
  alt: string | null;
};

export type CompatIssue = {key: string; problem: string; fix: string; link: {href: string; label: string}};
export type CompatAlert = {locale: CompatLocale; heading: string; note: string; issues: CompatIssue[]};

type Catalog = Record<string, CompatPart>;

/** How many attributes two parts share: the closer swap wins. */
function likeness(a: CompatPart, b: CompatPart): number {
  const va = a as unknown as Record<string, unknown>;
  const vb = b as unknown as Record<string, unknown>;
  return Object.keys(va).filter((k) => JSON.stringify(va[k]) === JSON.stringify(vb[k])).length;
}

/**
 * The part to swap in for `sku` (same kind) so the rule passes against `other`
 * and the rest of the cart raises nothing new; the closest such part wins.
 */
function swapFor(rule: CompatRule, sku: string, other: CompatPart | Band, asPartner: boolean, ctx: Ctx): string | null {
  const part = ctx.catalog[sku];
  const rest = ctx.skus.filter((s) => s !== sku);
  const candidates = Object.entries(ctx.catalog).filter(([candidate, p]) => {
    if (ctx.skus.includes(candidate) || p.kind !== part.kind) return false;
    if ((asPartner ? rule.fits(other as CompatPart, p) : rule.fits(p, other)) !== true) return false;
    return !conflicts({...ctx, skus: [...rest, candidate]}, false).some((c) => c.a === candidate || c.b === candidate);
  });
  candidates.sort(([, x], [, y]) => likeness(y, part) - likeness(x, part));
  return candidates[0]?.[0] ?? null;
}

type Ctx = {skus: string[]; country: string | null; catalog: Catalog; rules: readonly CompatRule[]};

/**
 * Every conflict in a cart. A part is flagged against a partner kind only when
 * the cart holds that kind and none of it fits, so a cart with two complete
 * builds stays quiet. One conflict per pair of parts, first rule wins.
 */
export function findConflicts(skus: readonly string[], country: string | null, catalog: Catalog = COMPAT_PARTS, rules: readonly CompatRule[] = COMPAT_RULES): CompatConflict[] {
  return conflicts({skus: [...new Set(skus)].filter((s) => s in catalog), country: country?.toUpperCase() ?? null, catalog, rules}, true);
}

function conflicts(ctx: Ctx, withSwaps: boolean): CompatConflict[] {
  const {skus: inCart, country, catalog, rules} = ctx;
  const out: CompatConflict[] = [];
  const seen = new Set<string>();
  const band: Band | undefined = country ? SUB_GHZ_BY_COUNTRY[country] : undefined;
  for (const rule of rules) {
    for (const a of inCart) {
      const pa = catalog[a];
      if (!rule.a.includes(pa.kind)) continue;
      if (rule.b === 'region') {
        if (!band || !country || rule.fits(pa, band) !== false) continue;
        const key = `${a}|region`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({rule: rule.id, a, b: country, ...rule.values(pa, band), alt: withSwaps ? swapFor(rule, a, band, false, ctx) : null});
        continue;
      }
      const kinds = rule.b;
      const partners = inCart.filter((s) => s !== a && kinds.includes(catalog[s].kind));
      // Any partner that fits, or that cannot be judged, keeps the part quiet.
      if (!partners.length || partners.some((b) => rule.fits(pa, catalog[b]) !== false)) continue;
      const b = partners[0];
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const alt = withSwaps ? swapFor(rule, a, catalog[b], false, ctx) ?? swapFor(rule, b, pa, true, ctx) : null;
      out.push({rule: rule.id, a, b, ...rule.values(pa, catalog[b]), alt});
    }
  }
  return out;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function compatLocale(x: string | null | undefined): CompatLocale {
  return (COMPAT_LOCALES as readonly string[]).includes(x ?? '') ? (x as CompatLocale) : 'en';
}

/** The conflicts in plain words, in the visitor's language. */
export function explainConflicts(conflicts: readonly CompatConflict[], locale: CompatLocale, catalog: Catalog = COMPAT_PARTS, rules: readonly CompatRule[] = COMPAT_RULES): CompatAlert {
  const ui = COMPAT_UI[locale];
  const issues = conflicts.flatMap((c): CompatIssue[] => {
    const rule = rules.find((r) => r.id === c.rule);
    if (!rule) return [];
    const msg = rule.messages[locale];
    const vars = {a: catalog[c.a].name, b: catalog[c.b]?.name ?? c.b, aValue: c.aValue, bValue: c.bValue};
    const target = catalog[c.alt ?? c.a];
    return [{
      key: `${c.rule}:${c.a}:${c.b}`,
      problem: fill(msg.problem, vars),
      fix: c.alt ? fill(ui.swap, {alt: catalog[c.alt].name}) : fill(msg.fix, vars),
      link: {href: `/products/${target.handle}`, label: fill(ui.see, {name: target.name})},
    }];
  });
  return {locale, heading: ui.heading, note: ui.note, issues};
}

/** The cart's alert for these SKUs and this ship-to country. */
export function cartCompatAlert(skus: readonly string[], country: string | null, locale: CompatLocale): CompatAlert {
  return explainConflicts(findConflicts(skus, country), locale);
}

/** The same alert for a cart whose lines carry a `sku` (the Shopify cart on /cart, the app cart on /shop/cart). Never throws: a cart page must render without it. */
export function compatForLines(lines: ReadonlyArray<{sku?: string | null}>, country: string | null, locale: CompatLocale): CompatAlert {
  try {
    return cartCompatAlert(lines.flatMap((l) => (l.sku ? [l.sku] : [])), country, locale);
  } catch (err) {
    console.error('cart-compat', err);
    return {locale, heading: '', note: '', issues: []};
  }
}
