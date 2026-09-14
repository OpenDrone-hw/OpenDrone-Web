import {useRouteLoaderData} from 'react-router';
import type {Storefront} from '@shopify/hydrogen';
import type {RootLoader} from '~/root';
import {
  isPurchasableStatus,
  resolveStatus,
  PRODUCT_CONTENT,
  type ProductStatus,
} from '~/lib/product-content';
import {
  statusForHandle,
  type ProductStatus as RoadmapStatus,
} from '~/lib/roadmap-data';
import {preorderNote} from '~/lib/preorder';

// The pure pre-order helpers live in app/lib/preorder.ts (bundler-free, so
// the node:test suites can load them); re-exported here for the app.
export {
  PREORDER_ATTR_KEY,
  preorderNote,
  stampPreorderLines,
} from '~/lib/preorder';

/**
 * Every product handle's resolved tri-state, for the root loader: the
 * client-side hooks read this map so live topic flags (server-fetched)
 * reach every component without each one refetching.
 */
export function resolveAllStatuses(
  globalFlag: boolean,
  flags: Record<string, RoadmapStatus> = {},
  preordersOpen = false,
): Record<string, ProductStatus> {
  const out: Record<string, ProductStatus> = {};
  for (const handle of Object.keys(PRODUCT_CONTENT)) {
    out[handle] = resolveStatus(handle, globalFlag, flags, preordersOpen);
  }
  return out;
}

/**
 * The five-stage roadmap word per handle (beta, alpha, ...), for the
 * status chips on cards and PDPs — display vocabulary, not the buyability
 * tri-state. Only roadmap handles appear in the map.
 */
export function roadmapStatusMap(
  flags: Record<string, RoadmapStatus> = {},
): Record<string, RoadmapStatus> {
  const out: Record<string, RoadmapStatus> = {};
  for (const handle of Object.keys(PRODUCT_CONTENT)) {
    const s = statusForHandle(handle, flags);
    if (s) out[handle] = s;
  }
  return out;
}

/**
 * The roadmap word for one handle, from the root loader's live-resolved
 * map; static fallback when root data is unavailable. Undefined for
 * products off the roadmap (accessories).
 */
export function useRoadmapStatus(
  handle?: string | null,
): RoadmapStatus | undefined {
  return useRoadmapStatusResolver()(handle);
}

/**
 * Same resolution as {@link useRoadmapStatus}, as a plain function for
 * components that resolve MANY handles in a loop (header pods): call the
 * hook once, use the closure per item.
 */
export function useRoadmapStatusResolver(): (
  handle?: string | null,
) => RoadmapStatus | undefined {
  const data = useRouteLoaderData<RootLoader>('root');
  return (handle) =>
    handle
      ? (data?.roadmapStatuses?.[handle] ?? statusForHandle(handle))
      : undefined;
}

/**
 * Coming-soon state for a product, resolved from the root loader's
 * PUBLIC_COMING_SOON flag + the per-product override in product-content.ts.
 * Works in any component under root — no prop drilling. Defaults to
 * coming-soon when root data is unavailable (error boundaries), matching
 * the flag's fail-closed default.
 */
export function useComingSoon(handle?: string | null): boolean {
  return !isPurchasableStatus(useProductStatus(handle));
}

/**
 * Lifecycle status for a product, same resolution + fail-closed default
 * as {@link useComingSoon} (missing root data = 'development', never a
 * buyable state by accident).
 *
 * The root loader ships `productStatuses`, resolved server-side WITH the
 * live GitHub topic flags; when the map has the handle it wins, so a topic
 * flip reaches every card and buy module on the next request. The local
 * resolution below is the fallback (error boundaries, handles off the
 * map) and sees only the static roadmap statuses.
 */
export function useProductStatus(handle?: string | null): ProductStatus {
  return useProductStatusResolver()(handle);
}

/**
 * The same resolution as {@link useProductStatus}, as a plain function for
 * components that resolve MANY handles in a loop (header pods, search
 * rows, stack offers): call the hook once at the top, use the closure per
 * item. Keeps every client surface on the root loader's live-topic map
 * instead of quietly falling back to the static list.
 */
export function useProductStatusResolver(): (
  handle?: string | null,
) => ProductStatus {
  const data = useRouteLoaderData<RootLoader>('root');
  const map = data?.productStatuses;
  const globalFlag = data?.comingSoon ?? true;
  const preordersOpen = data?.preordersOpen ?? false;
  return (handle) =>
    (handle ? map?.[handle] : undefined) ??
    resolveStatus(handle, globalFlag, {}, preordersOpen);
}

/**
 * Resolve the global coming-soon flag from env — the single rule (shared
 * with root.tsx): defaults ON, `PUBLIC_COMING_SOON=0` unlocks the shop.
 * Server-side twin of {@link useComingSoon} for loaders/actions that have
 * no root loader data (feeds, cart gate).
 */
export function comingSoonFlag(env: {PUBLIC_COMING_SOON?: string}): boolean {
  return env.PUBLIC_COMING_SOON !== '0';
}

/**
 * Whether pre-order products take orders while the shop is still coming
 * soon: defaults OFF, `PUBLIC_PREORDERS=1` opens them. Set on the Oxygen
 * preview environment for end-to-end order tests before launch; on
 * production the coming-soon flag dropping opens pre-orders by itself.
 */
export function preordersOpenFlag(env: {PUBLIC_PREORDERS?: string}): boolean {
  return env.PUBLIC_PREORDERS === '1';
}

/**
 * Whether ANY product can currently be locked: the global flag is on, or
 * it's off but a per-product `comingSoon: true` override keeps a SKU
 * teasing. Guards the zero-cost unlock path — when this is false the cart
 * gate and feeds skip their coming-soon work entirely, so the unlocked
 * shop pays nothing for the feature.
 */
export function anyComingSoonLocks(
  globalFlag: boolean,
  flags: Record<string, RoadmapStatus> = {},
): boolean {
  if (globalFlag) return true;
  if (
    Object.values(PRODUCT_CONTENT).some(
      (c) =>
        c.comingSoon === true || c.status === 'idea' || c.status === 'development',
    )
  ) {
    return true;
  }
  // Roadmap-driven locks: any known handle that does not resolve to a
  // purchasable status (an alpha board with a product page) keeps the cart
  // gate armed.
  return Object.keys(PRODUCT_CONTENT).some(
    (h) => !isPurchasableStatus(resolveStatus(h, globalFlag, flags)),
  );
}

// Server-side purchase gate: resolve variant gids → product handles in one
// storefront round-trip so cart mutations can drop lines for coming-soon
// products. The client already hides add-to-cart; this closes the direct
// POST / cart-permalink path.
const COMING_SOON_VARIANT_PRODUCTS_QUERY = `#graphql
  query ComingSoonVariantProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        product {
          handle
        }
      }
    }
  }
` as const;

/**
 * Given cart-line merchandise gids, return the set that belongs to
 * coming-soon products (plus their handles, for messaging/redirects) and
 * the set that belongs to pre-order products (so the cart action can stamp
 * the pre-order attribute on those lines). Callers must check
 * {@link anyComingSoonLocks} or {@link anyPreorderProducts} first: this
 * always queries. Fail-closed: if the lookup errors while the gate is
 * active, every requested id is treated as locked (matching the `?? true`
 * default everywhere else in the feature).
 */
export async function findLockedMerchandise(
  storefront: Storefront,
  globalFlag: boolean,
  merchandiseIds: string[],
  flags: Record<string, RoadmapStatus> = {},
  preordersOpen = false,
): Promise<{
  lockedIds: Set<string>;
  lockedHandles: string[];
  /** merchandise gid -> the product's ship promise, for pre-order lines. */
  preorderNotes: Map<string, string>;
}> {
  const ids = [...new Set(merchandiseIds)].filter(Boolean);
  if (ids.length === 0) {
    return {lockedIds: new Set(), lockedHandles: [], preorderNotes: new Map()};
  }
  try {
    const data = await storefront.query(COMING_SOON_VARIANT_PRODUCTS_QUERY, {
      variables: {ids},
      cache: storefront.CacheShort(),
    });
    const lockedIds = new Set<string>();
    const lockedHandles = new Set<string>();
    const preorderNotes = new Map<string, string>();
    for (const node of data.nodes ?? []) {
      const handle = node?.product?.handle;
      if (!node?.id || !handle) continue;
      const status = resolveStatus(handle, globalFlag, flags, preordersOpen);
      if (!isPurchasableStatus(status)) {
        lockedIds.add(node.id);
        lockedHandles.add(handle);
      } else if (status === 'preorder') {
        preorderNotes.set(node.id, preorderNote(handle));
      }
    }
    return {lockedIds, lockedHandles: [...lockedHandles], preorderNotes};
  } catch (err) {
    console.error('[coming-soon] variant lookup failed — blocking lines', err);
    return {
      lockedIds: new Set(ids),
      lockedHandles: [],
      preorderNotes: new Map(),
    };
  }
}

