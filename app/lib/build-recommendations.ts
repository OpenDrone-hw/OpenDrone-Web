/**
 * "Complete your build": the parts that finish a quad around what was just
 * added. Compatibility is a hard constraint: a 20×20 stack only ever meets a
 * 3" frame and 1604 motors. Shopify's complementary-product ranking may
 * reorder the parts, never add one from the wrong build.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import type {ProductCardFragment, ProductVariantFragment} from './product-shapes.ts';

export type BuildRole = 'flight-controller' | 'esc' | 'frame' | 'motors' | 'receiver';
export type BuildProfileId = '3-inch' | '5-inch';

type BuildComponent = {role: BuildRole; handle: string; sku: string; quantity: number};

export type BuildSuggestion = BuildComponent & {
  product: ProductCardFragment;
  variant: ProductVariantFragment;
};

const BUILD_PROFILES: ReadonlyArray<{
  id: BuildProfileId;
  sourceSku: RegExp;
  components: readonly BuildComponent[];
}> = [
  {
    id: '3-inch',
    sourceSku: /(?:2020|FRAME-3|MOTOR-1604)$/,
    components: [
      {role: 'flight-controller', handle: 'openfc-lite', sku: 'OPENFC-LITE-2020', quantity: 1},
      {role: 'esc', handle: 'openesc', sku: 'OPENESC-2020', quantity: 1},
      {role: 'frame', handle: 'openframe', sku: 'OPENFRAME-3', quantity: 1},
      {role: 'motors', handle: 'openmotor', sku: 'OPENMOTOR-1604', quantity: 4},
      {role: 'receiver', handle: 'openrx', sku: 'OPENRX-LITE', quantity: 1},
    ],
  },
  {
    id: '5-inch',
    sourceSku: /(?:3030|FRAME-5|MOTOR-2207)$/,
    components: [
      {role: 'flight-controller', handle: 'openfc-lite', sku: 'OPENFC-LITE-3030', quantity: 1},
      {role: 'esc', handle: 'openesc', sku: 'OPENESC-3030', quantity: 1},
      {role: 'frame', handle: 'openframe', sku: 'OPENFRAME-5', quantity: 1},
      {role: 'motors', handle: 'openmotor', sku: 'OPENMOTOR-2207', quantity: 4},
      {role: 'receiver', handle: 'openrx', sku: 'OPENRX-GEMINI', quantity: 1},
    ],
  },
];

/** The build size a SKU belongs to, or null for a size-neutral part (a receiver). */
export function buildProfileId(sku: string | null | undefined): BuildProfileId | null {
  return BUILD_PROFILES.find((p) => p.sourceSku.test(sku ?? ''))?.id ?? null;
}

/**
 * The build to complete: the added SKU's own size, else the first sized part
 * already in the cart (a receiver added after a 20×20 stack completes the
 * 3" build). Null when nothing in reach has a size.
 */
export function resolveProfile(
  sourceSku: string | null | undefined,
  cartSkus: readonly string[] = [],
): BuildProfileId | null {
  return buildProfileId(sourceSku) ?? cartSkus.map(buildProfileId).find(Boolean) ?? null;
}

/**
 * The parts to suggest, in order: everything in the profile except what the
 * cart already holds (by product, so a 30×30 ESC in the cart also rules out
 * suggesting a 20×20 one), Shopify's ranking first, the build order after.
 */
export function buildSuggestionSpecs(
  profileId: BuildProfileId | null,
  cartHandles: readonly string[] = [],
  preferredHandles: readonly string[] = [],
): BuildComponent[] {
  const profile = BUILD_PROFILES.find((p) => p.id === profileId);
  if (!profile) return [];
  const inCart = new Set(cartHandles);
  const rank = new Map(preferredHandles.map((handle, index) => [handle, index]));
  return profile.components
    .filter((c) => !inCart.has(c.handle))
    .map((component, index) => ({component, index}))
    .sort(
      (a, b) =>
        (rank.get(a.component.handle) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.component.handle) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({component}) => component);
}

/**
 * Suggestions resolved against the catalog cards: only variants that exist
 * and can be sold right now (`sellable` applies the storefront status gate).
 */
export function resolveBuildSuggestions(
  products: readonly ProductCardFragment[],
  specs: readonly BuildComponent[],
  sellable: (handle: string, variant: ProductVariantFragment) => boolean,
): BuildSuggestion[] {
  return specs.flatMap((spec) => {
    const product = products.find((p) => p.handle === spec.handle);
    const variant = product?.variants.nodes.find((v) => v.sku === spec.sku);
    return product && variant && variant.availableForSale && sellable(product.handle, variant)
      ? [{...spec, product, variant}]
      : [];
  });
}
