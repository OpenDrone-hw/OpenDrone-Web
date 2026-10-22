/**
 * Shopify's cart permalinks, `/cart/<variant id>:<qty>,<variant id>:<qty>` with an optional `?discount=<code>`, as the
 * app cart reads them: each id is matched to a catalog variant by its app id or by the Shopify id it came from (`alias`,
 * as for old `?variant=` links), and the lines are added to the app cart. An unknown or sold-out variant is skipped.
 *
 * Plain TypeScript with relative imports only: the node:test suites load it without the bundler.
 */
import type {CartLine} from './app-api.ts';
import {variantKey} from '../legacy-urls.ts';

type VariantLike = {merchandise_id?: string; alias?: string; availability?: string | null};
type CatalogLike = {products: ReadonlyArray<{variants: readonly VariantLike[]}>};

const MAX_PARTS = 20;
const MAX_QTY = 50;

export function permalinkLines(spec: string, catalog: CatalogLike): CartLine[] {
  const variants = catalog.products.flatMap((p) => p.variants);
  const out: CartLine[] = [];
  for (const part of spec.split(',').slice(0, MAX_PARTS)) {
    const [id, rawQty] = part.split(':');
    const key = variantKey(id);
    const qty = rawQty === undefined ? 1 : Number(rawQty);
    if (!key || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) continue;
    const hit = variants.find((v) => variantKey(v.merchandise_id) === key || variantKey(v.alias) === key);
    if (!hit?.merchandise_id || hit.availability === 'sold_out') continue;
    out.push({variant: hit.merchandise_id, qty});
  }
  return out;
}
