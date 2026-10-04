/**
 * The parts a product page offers next to its own, and the build it sits
 * in. Compatibility comes from `content/builds.json` only: a 20x20 FC page
 * offers the 20x20 ESC, never the 30x30 one.
 *
 * Bundler-free (relative imports) so the node:test suites can load it; the
 * build data is passed in.
 */

import {partHandle, type BuildRole, type BuildsConfig} from './build-recommendations.ts';

/** What a page of each role shows first, in this order. */
export const COMPLEMENTS: Record<BuildRole, BuildRole[]> = {
  'flight-controller': ['esc'],
  esc: ['flight-controller'],
  frame: ['motors', 'flight-controller', 'esc'],
  motors: ['frame', 'props'],
  receiver: ['antenna'],
  props: [],
  antenna: [],
};

/** One related card: a product, the exact variant when the size is known,
 *  and how many one quad takes. */
export type RelatedPart = {handle: string; sku: string | null; quantity: number};

/** The role a product plays in the builds, or null for an accessory. */
export function productRole(config: BuildsConfig, handle: string): BuildRole | null {
  for (const build of config.builds) {
    const part = build.parts.find((p) => partHandle(config, p) === handle);
    if (part) return part.role;
  }
  return null;
}

/** The ids of the builds that use this product, in build order. */
export function buildsWithProduct(config: BuildsConfig, handle: string): string[] {
  return config.builds
    .filter((b) => b.parts.some((p) => partHandle(config, p) === handle))
    .map((b) => b.id);
}

/**
 * The build a product page opens on: the build that lists the selected SKU,
 * else the build whose SKU the selected one is a variant of
 * (OPENMOTOR-1604-4S of OPENMOTOR-1604), else the first build that uses the
 * product. Null for a product in no build.
 */
export function buildForProduct(
  config: BuildsConfig,
  handle: string,
  sku: string | null | undefined,
): string | null {
  const own = config.builds.filter((b) => b.parts.some((p) => partHandle(config, p) === handle));
  if (sku) {
    const exact = own.find((b) => b.parts.some((p) => p.sku === sku));
    if (exact) return exact.id;
    const variant = own.find((b) =>
      b.parts.some((p) => partHandle(config, p) === handle && sku.startsWith(`${p.sku}-`)),
    );
    if (variant) return variant.id;
  }
  return own[0]?.id ?? null;
}

/**
 * The related cards for a product page, in order: the parts of the same
 * build that complete it (`COMPLEMENTS`), then the spares and accessories
 * `builds.json` lists for the selected SKU, then the rest of the catalog in
 * `otherHandles` order. The page's own product never appears.
 */
export function relatedParts(
  config: BuildsConfig,
  page: {handle: string; sku: string | null | undefined},
  otherHandles: readonly string[] = [],
): RelatedPart[] {
  const out: RelatedPart[] = [];
  const add = (part: RelatedPart) => {
    if (part.handle === page.handle) return;
    if (out.some((p) => p.handle === part.handle && (p.sku === part.sku || p.sku === null || part.sku === null))) return;
    out.push(part);
  };
  const role = productRole(config, page.handle);
  const build = config.builds.find((b) => b.id === buildForProduct(config, page.handle, page.sku));
  const extras = config.extras ?? [];
  const forSku = page.sku ? extras.filter((e) => e.with.includes(page.sku!)) : [];
  for (const wanted of role ? COMPLEMENTS[role] : []) {
    const before = out.length;
    for (const p of build?.parts.filter((x) => x.role === wanted) ?? []) {
      add({handle: partHandle(config, p), sku: p.sku, quantity: p.quantity});
    }
    for (const e of forSku.filter((x) => x.role === wanted)) {
      add({handle: e.handle, sku: e.sku, quantity: e.quantity});
    }
    // A role with no part for this SKU still names its product.
    const fallback = config.roles[wanted].handle;
    if (out.length === before && fallback) add({handle: fallback, sku: null, quantity: 1});
  }
  for (const e of forSku) add({handle: e.handle, sku: e.sku, quantity: e.quantity});
  for (const handle of otherHandles) add({handle, sku: null, quantity: 1});
  return out;
}
