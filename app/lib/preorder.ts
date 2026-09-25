/**
 * The pre-order ship promise, kept dependency-free (product content and
 * copy only, both bundler-free) so the node:test suites can import it
 * without Vite. `app/lib/coming-soon.ts` re-exports it for the app.
 *
 * Pass the catalog's `ship_promise` as `fromCatalog` wherever a variant is
 * in hand, so every surface shows the same words.
 */

// Relative imports on purpose: the node:test suites run this module without
// Vite, so the `~` alias is not available here.
import {PRODUCT_CONTENT} from './product-content.ts';
import {copyText} from './copy.ts';

/**
 * The ship promise for a pre-order product: the catalog's word for it when
 * the caller has the catalog variant in hand, else the content file's
 * `statusNote`, else the shop-wide default from copy. The literal fallback
 * mirrors `product-chrome.preorder_lead_default` for the bundler-free test
 * path.
 */
export function preorderNote(
  handle: string,
  fromCatalog?: string | null,
): string {
  return (
    fromCatalog ||
    PRODUCT_CONTENT[handle]?.statusNote ||
    copyText('product-chrome.preorder_lead_default') ||
    'ships in about 10 weeks'
  );
}

/**
 * The ship promise the buy module prints, as opposed to the pre-order note
 * above: the catalog variant decides whenever it carries the key, INCLUDING
 * when it decides `null`, and only an absent key falls back to the content
 * file's `statusNote`.
 *
 * The distinction is the whole point. The closed-storefront policy
 * (`SHOPIFY_PREVIEW_POLICY_JSON`) sets `shipPromise: null` on every sold_out
 * SKU deliberately, and `app/lib/shopify-storefront.ts` refuses to build a
 * closed SKU that carries one. Coalescing that null with `??` republished a
 * dispatch date the policy had just withdrawn, on a storefront whose checkout
 * is closed.
 *
 * A closed shop (`shopOpen` false: coming soon or checkout closed) prints no
 * promise at all: a dispatch date next to "Coming soon" reads as an offer
 * nobody can take up.
 */
export function shipPromiseFor(
  variantPromise: string | null | undefined,
  statusNote?: string | null,
  shopOpen = true,
): string | null {
  if (!shopOpen) return null;
  if (variantPromise !== undefined) return variantPromise;
  return statusNote ?? null;
}
