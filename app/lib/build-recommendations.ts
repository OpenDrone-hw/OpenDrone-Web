/**
 * "Complete the build": the parts that finish a quad around what was just
 * added. Compatibility comes from `content/builds.json` and is a hard
 * constraint: a 20x20 stack only ever meets a 3" frame and 1604 motors.
 *
 * Bundler-free (relative imports) so the node:test suites can load it; the
 * build data is passed in.
 */

import type {ProductCardFragment, ProductVariantFragment} from './product-shapes.ts';

export type BuildRole =
  | 'flight-controller'
  | 'esc'
  | 'frame'
  | 'motors'
  | 'receiver'
  | 'props'
  | 'antenna';

export type BuildsConfig = {
  roles: Record<BuildRole, {handle?: string; sizeNeutral?: boolean}>;
  builds: Array<{
    id: string;
    label: string;
    /** `handle` names the product when the role has none of its own (each
     *  prop set is its own product). */
    parts: Array<{role: BuildRole; sku: string; quantity: number; handle?: string}>;
  }>;
};

/** The product handle of a build part: its own, else its role's. */
export function partHandle(
  config: BuildsConfig,
  part: {role: BuildRole; handle?: string},
): string {
  return part.handle ?? config.roles[part.role].handle ?? '';
}

export type BuildPart = {role: BuildRole; handle: string; sku: string; quantity: number};

export type BuildSuggestion = BuildPart & {
  product: ProductCardFragment;
  variant: ProductVariantFragment;
  /** A part of this role is in the cart, but for the other build size. */
  replaces: string | null;
};

type CartLine = {sku: string | null; handle: string; variantTitle?: string};

/** Accept `content/builds.json`, or throw on anything malformed. */
export function parseBuilds(body: unknown): BuildsConfig {
  const c = body as Partial<BuildsConfig> | null;
  if (!c?.roles || !Array.isArray(c.builds)) throw new Error('builds: roles and builds are required');
  for (const build of c.builds) {
    for (const part of build.parts ?? []) {
      if (!c.roles[part.role]) throw new Error(`builds: ${build.id} uses unknown role ${part.role}`);
      if (!part.handle && !c.roles[part.role].handle) {
        throw new Error(`builds: ${build.id} ${part.sku} has no product handle`);
      }
      if (!Number.isSafeInteger(part.quantity) || part.quantity < 1) {
        throw new Error(`builds: ${build.id} ${part.sku} needs a positive quantity`);
      }
    }
  }
  return c as BuildsConfig;
}

/** The build a SKU belongs to, or null for a part in no build (a receiver
 *  variant that no build names, say). */
export function buildOf(config: BuildsConfig, sku: string | null | undefined): string | null {
  if (!sku) return null;
  return config.builds.find((b) => b.parts.some((p) => p.sku === sku && !config.roles[p.role].sizeNeutral))?.id ?? null;
}

/**
 * The build to complete: the added SKU's own size, else the first sized
 * part already in the cart (a receiver added after a 20×20 stack completes
 * the 3" build). Null when nothing in reach has a size.
 */
export function resolveBuild(
  config: BuildsConfig,
  sourceSku: string | null | undefined,
  cartSkus: readonly (string | null)[] = [],
): string | null {
  return buildOf(config, sourceSku) ?? cartSkus.map((s) => buildOf(config, s)).find(Boolean) ?? null;
}

/** The role a cart line plays, from its SKU (sized parts) or handle (size-neutral roles). */
function roleOf(config: BuildsConfig, line: CartLine): {role: BuildRole; build: string | null} | null {
  for (const build of config.builds) {
    const part = build.parts.find((p) => p.sku === line.sku);
    if (part) return {role: part.role, build: config.roles[part.role].sizeNeutral ? null : build.id};
  }
  for (const [role, def] of Object.entries(config.roles) as Array<[BuildRole, BuildsConfig['roles'][BuildRole]]>) {
    if (def.sizeNeutral && def.handle === line.handle) return {role, build: null};
  }
  return null;
}

/**
 * The parts to suggest for `buildId`, in order: every part whose role the
 * cart does not already fill for this size (a size-neutral role is filled by
 * any matching product), Shopify's ranking first, the build order after. A
 * part whose role the cart fills with the other size stays, carrying the
 * cart's version in `replaces`, so the dialog can say the sizes differ.
 */
export function buildSuggestionSpecs(
  config: BuildsConfig,
  buildId: string | null,
  cart: readonly CartLine[] = [],
  preferredHandles: readonly string[] = [],
): Array<BuildPart & {replaces: string | null}> {
  const build = config.builds.find((b) => b.id === buildId);
  if (!build) return [];
  const filled = new Set<string>();
  const otherSize = new Map<BuildRole, string>();
  for (const line of cart) {
    const r = roleOf(config, line);
    if (!r) continue;
    if (r.build === null || r.build === build.id) filled.add(r.role);
    else otherSize.set(r.role, line.variantTitle || line.sku || '');
  }
  const rank = new Map(preferredHandles.map((handle, index) => [handle, index]));
  return build.parts
    .filter((p) => !filled.has(p.role))
    .map((p, index) => ({
      part: {
        ...p,
        handle: partHandle(config, p),
        replaces: otherSize.get(p.role) ?? null,
      },
      index,
    }))
    .sort(
      (a, b) =>
        (rank.get(a.part.handle) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.part.handle) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({part}) => part);
}

/**
 * Suggestions resolved against the catalog cards: only variants that exist
 * and can be sold right now (`sellable` applies the storefront status gate).
 */
export function resolveBuildSuggestions(
  products: readonly ProductCardFragment[],
  specs: ReadonlyArray<BuildPart & {replaces: string | null}>,
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
