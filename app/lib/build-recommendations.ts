import type {ProductCardFragment, ProductVariantFragment} from './product-shapes';

export type BuildRole = 'flight-controller' | 'esc' | 'frame' | 'motors' | 'receiver';

export type BuildSuggestion = {
  role: BuildRole;
  handle: string;
  sku: string;
  quantity: number;
  product: ProductCardFragment;
  variant: ProductVariantFragment;
};

type BuildComponent = {
  role: BuildRole;
  handle: string;
  sku: string;
  quantity: number;
};

type BuildProfile = {
  id: '3-inch' | '5-inch';
  sourceSku: RegExp;
  components: readonly BuildComponent[];
};

/**
 * Compatibility is a hard constraint, not a behavioral recommendation.
 * Shopify complementary-product relationships can rank these nodes, but can
 * never introduce a component from the wrong build profile.
 */
const BUILD_PROFILES: readonly BuildProfile[] = [
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

export function buildProfileId(sku: string | null | undefined): BuildProfile['id'] | null {
  return BUILD_PROFILES.find((profile) => profile.sourceSku.test(sku ?? ''))?.id ?? null;
}

export function buildSuggestionSpecs(
  sourceHandle: string | null | undefined,
  sourceSku: string | null | undefined,
  preferredHandles: readonly string[] = [],
): BuildComponent[] {
  const profile = BUILD_PROFILES.find((candidate) => candidate.sourceSku.test(sourceSku ?? ''));
  if (!profile) return [];
  const preference = new Map(preferredHandles.map((handle, index) => [handle, index]));
  return profile.components
    .filter((component) => component.handle !== sourceHandle)
    .map((component, index) => ({component, index}))
    .sort((a, b) => {
      const aRank = preference.get(a.component.handle) ?? Number.MAX_SAFE_INTEGER;
      const bRank = preference.get(b.component.handle) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank || a.index - b.index;
    })
    .map(({component}) => component);
}

export function resolveBuildSuggestions(
  products: readonly ProductCardFragment[],
  sourceHandle: string | null | undefined,
  sourceSku: string | null | undefined,
  preferredHandles: readonly string[] = [],
): BuildSuggestion[] {
  return buildSuggestionSpecs(sourceHandle, sourceSku, preferredHandles).flatMap((spec) => {
    const product = products.find((candidate) => candidate.handle === spec.handle);
    const variant = product?.variants.nodes.find((candidate) => candidate.sku === spec.sku);
    return product && variant ? [{...spec, product, variant}] : [];
  });
}
