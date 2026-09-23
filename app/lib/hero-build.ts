/**
 * The homepage walkthrough as a build guide: each build of
 * `content/builds.json` resolved against the catalog, so a tour step can show
 * the pick for its part (product, variant, live price, ship promise, the
 * one-line add) and the last step the whole list with its total and one add
 * for everything.
 *
 * Bundler-free (relative imports) so the node:test suites can load it; the
 * build data, the catalog and the display rules are passed in.
 */

import {cartAddUrl} from './catalog.ts';
import type {MoneyV2, ProductCardFragment, ProductVariantFragment} from './product-shapes.ts';

/** The shape of `content/builds.json` this module reads. A part may name its
 *  own product handle; otherwise its role's handle applies. */
export type HeroBuildsConfig = {
  roles: Record<string, {handle?: string; sizeNeutral?: boolean}>;
  builds: Array<{
    id: string;
    label: string;
    parts: Array<{role: string; sku: string; quantity: number; handle?: string}>;
  }>;
};

export type HeroPick = {
  role: string;
  handle: string;
  sku: string;
  /** Units one quad needs (4 motors). */
  quantity: number;
  /** "OpenFC Lite 20x20". */
  name: string;
  /** Product page with this variant selected. */
  url: string;
  /** Price of one unit. */
  price: MoneyV2;
  /** Catalog ship promise, for the ship chip. */
  shipPromise: string | null;
  /** The storefront shows this product's price (its status gate). */
  listed: boolean;
  /** Can be added to the cart now. */
  buyable: boolean;
  /** Cart hand-off for `quantity` units, for AddToCartButton. */
  addHref: string;
};

export type HeroBuild = {
  id: string;
  label: string;
  /** The parts the catalog has, in builds.json order. */
  parts: HeroPick[];
  /** Sum of every listed part times its quantity. */
  total: number;
  currency: string;
  /** One hand-off for every buyable part, or null when none can be added. */
  addHref: string | null;
};

/** A role's accessories, shown on the same tour step as the role's part. */
const STEP_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  motors: ['props'],
  receiver: ['antenna'],
  frame: ['strap'],
};

const CART_PATH = '/api/shopify/cart';

/** `/products/<handle>?Model=20x20`: the link selects the variant. */
export function pickUrl(handle: string, variant: Pick<ProductVariantFragment, 'selectedOptions'>): string {
  const query = new URLSearchParams(
    variant.selectedOptions
      .filter((o) => o.name && o.value && o.value !== 'Default Title')
      .map((o): [string, string] => [o.name, o.value]),
  ).toString();
  return `/products/${handle}${query ? `?${query}` : ''}`;
}

export function resolveHeroBuilds(
  config: HeroBuildsConfig,
  products: readonly ProductCardFragment[],
  opts: {
    /** The storefront status gate for a product. */
    sellable: (handle: string) => boolean;
    /** The buyer's name for a line (product title plus variant label). */
    nameOf: (handle: string, title: string, variantTitle: string) => string;
  },
): HeroBuild[] {
  return config.builds.map((build) => {
    const parts = build.parts.flatMap((part): HeroPick[] => {
      const handle = part.handle ?? config.roles[part.role]?.handle ?? '';
      const product = products.find((p) => p.handle === handle);
      const variant = product?.variants.nodes.find((v) => v.sku === part.sku);
      if (!product || !variant) return [];
      const quantity = Math.max(1, Math.round(part.quantity || 1));
      const listed = opts.sellable(handle);
      return [
        {
          role: part.role,
          handle,
          sku: part.sku,
          quantity,
          name: opts.nameOf(handle, product.title, variant.title),
          url: pickUrl(handle, variant),
          price: variant.price,
          shipPromise: variant.shipPromise,
          listed,
          buyable: listed && variant.availableForSale,
          addHref: cartAddUrl(CART_PATH, [{sku: part.sku, quantity}]),
        },
      ];
    });
    const buyable = parts.filter((p) => p.buyable);
    return {
      id: build.id,
      label: build.label,
      parts,
      total: parts.reduce((sum, p) => sum + (p.listed ? (Number(p.price.amount) || 0) * p.quantity : 0), 0),
      currency: parts[0]?.price.currencyCode ?? 'EUR',
      addHref: buyable.length
        ? cartAddUrl(
            CART_PATH,
            buyable.map((p) => ({sku: p.sku, quantity: p.quantity})),
          )
        : null,
    };
  });
}

/**
 * The picks a tour step shows: the build's part for the step's product, then
 * that part's accessories (props with the motors, the antenna with the
 * receiver). Empty for a step with no product or a product the build lacks.
 */
export function picksForStep(build: HeroBuild | undefined, handle: string | undefined): HeroPick[] {
  if (!build || !handle) return [];
  const main = build.parts.find((p) => p.handle === handle);
  if (!main) return [];
  const extras = STEP_EXTRAS[main.role] ?? [];
  return [main, ...build.parts.filter((p) => extras.includes(p.role))];
}
