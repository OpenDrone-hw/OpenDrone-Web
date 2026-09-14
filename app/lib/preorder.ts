/**
 * Pre-order line helpers, kept dependency-free (product content and copy
 * only, both bundler-free) so the node:test suites can import them without
 * Vite. `app/lib/coming-soon.ts` re-exports them for the app.
 */

// Relative imports on purpose: the node:test suites run this module without
// Vite, so the `~` alias is not available here.
import {PRODUCT_CONTENT} from './product-content.ts';
import {copyText} from './copy.ts';

/** The line attribute key that marks a pre-order line. Shopify copies line
 *  attributes onto the order, so the operator sees it on the order page,
 *  in the bpost Shipping Manager import and on the packing slip. */
export const PREORDER_ATTR_KEY = 'Pre-order';

/**
 * The ship promise for a pre-order product: its own `statusNote` when the
 * content file carries one ("ships from early October 2026"), else the
 * shop-wide default from copy. The same string shows on the PDP buy
 * module, the cart line and the order, so the promise the customer read
 * is the promise on the contract. The literal fallback mirrors
 * `product-chrome.preorder_lead_default` for the bundler-free test path.
 */
export function preorderNote(handle: string): string {
  return (
    PRODUCT_CONTENT[handle]?.statusNote ??
    copyText('product-chrome.preorder_lead_default') ??
    'ships in about 10 weeks'
  );
}

/**
 * Stamp the pre-order attribute on the lines whose merchandise is a
 * pre-order product, and strip any client-supplied copy of it from the
 * rest: the attribute is a server statement about the product, never a
 * value the client may set.
 */
export function stampPreorderLines<
  L extends {
    merchandiseId?: string;
    attributes?: Array<{key: string; value: string}> | null;
  },
>(lines: L[], preorderNotes: Map<string, string>): L[] {
  return lines.map((line) => {
    const attributes = (line.attributes ?? []).filter(
      (a) => a.key !== PREORDER_ATTR_KEY,
    );
    const note = line.merchandiseId
      ? preorderNotes.get(line.merchandiseId)
      : undefined;
    if (note) attributes.push({key: PREORDER_ATTR_KEY, value: note});
    return {...line, attributes};
  });
}
