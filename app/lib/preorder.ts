/**
 * The pre-order ship promise, kept dependency-free (product content and
 * copy only, both bundler-free) so the node:test suites can import it
 * without Vite. `app/lib/coming-soon.ts` re-exports it for the app.
 *
 * Odoo stamps the promise onto the order line and prints it in the order
 * mail (`incutec_product.ship_promise`), so the storefront only has to
 * show the same words: pass the catalog's `ship_promise` as `fromCatalog`
 * wherever a variant is in hand.
 */

// Relative imports on purpose: the node:test suites run this module without
// Vite, so the `~` alias is not available here.
import {PRODUCT_CONTENT} from './product-content.ts';
import {copyText} from './copy.ts';

/**
 * The ship promise for a pre-order product: Odoo's own word for it when
 * the caller has the catalog variant in hand, else the content file's
 * `statusNote` ("ships from early October 2026"), else the shop-wide
 * default from copy. The same string shows on the PDP buy module, the
 * Odoo cart line and the order, so the promise the customer read is the
 * promise on the contract. The literal fallback mirrors
 * `product-chrome.preorder_lead_default` for the bundler-free test path.
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
 */
export function shipPromiseFor(
  variantPromise: string | null | undefined,
  statusNote?: string | null,
): string | null {
  if (variantPromise !== undefined) return variantPromise;
  return statusNote ?? null;
}
