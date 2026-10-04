/**
 * Where an Add to Cart click happened, sent as the `placement` prop of the
 * Plausible `Add to Cart` event so the weekly review can see which surface
 * sells. Low-cardinality by construction: one value per surface.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

export const CART_PLACEMENTS = [
  'buy_box',
  'sticky_bar',
  'build_block',
  'home_build',
  'catalog',
  'cart_dialog',
  'related',
] as const;

export type CartPlacement = (typeof CART_PLACEMENTS)[number];

/**
 * The placement an event reports: the button's own prop, else the nearest
 * surface around it (a React context on the page), else a build add with no
 * surface around it, which is the homepage build card, else `unknown`, so
 * a button that nobody labelled shows up in the review instead of hiding
 * under a real surface.
 */
export function resolvePlacement(
  own: CartPlacement | null | undefined,
  surrounding: CartPlacement | null | undefined,
  product: string | null | undefined,
): CartPlacement | 'unknown' {
  if (own) return own;
  if (surrounding) return surrounding;
  if (product?.startsWith('build-')) return 'home_build';
  return 'unknown';
}

/** The props of one `Add to Cart` event, before the attribution props. */
export function addToCartEventProps(input: {
  product: string | null | undefined;
  skus: readonly string[];
  placement: CartPlacement | 'unknown';
}): {product: string; sku: string; placement: string} {
  return {
    product: input.product || 'unknown',
    sku: input.skus.join('+') || 'unknown',
    placement: input.placement,
  };
}
