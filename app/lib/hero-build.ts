import {bySku, cartAddUrl, type Catalog, type CartLine} from './catalog.ts';
import {
  partHandle,
  type BuildsConfig,
  type BuildRole,
} from './build-recommendations.ts';
import {lineDisplayName} from './product-content.ts';

export const BUILD_ROLES: Record<BuildRole, {label: string; beat: string}> = {
  frame: {label: 'Frame', beat: 'frame'},
  motors: {label: 'Motors', beat: 'motor'},
  esc: {label: 'ESC', beat: 'esc'},
  'flight-controller': {label: 'Flight controller', beat: 'fc'},
  receiver: {label: 'Receiver', beat: 'rx'},
  props: {label: 'Propeller set', beat: 'motor'},
  antenna: {label: 'Receiver antenna', beat: 'rx'},
};

export type HeroBuildPart = {
  role: BuildRole;
  sku: string;
  handle: string;
  title: string;
  url: string;
  image: string | null;
  quantity: number;
  price: number | null;
  currency: string;
  available: boolean;
};

export type HeroBuild = {
  id: string;
  size: string;
  parts: HeroBuildPart[];
  addUrl: string;
};

/** Use the same exact SKU recipes as the cart's build suggestions. */
export function resolveHeroBuilds(
  config: BuildsConfig,
  catalog: Catalog,
): HeroBuild[] {
  return config.builds.map((build) => ({
    id: build.id,
    size: build.id.replace(/-inch$/, ''),
    addUrl: catalog.add_url,
    parts: build.parts.map((part) => {
      const handle = partHandle(config, part);
      const match = bySku(catalog, part.sku);
      const product = match?.product.handle === handle ? match.product : null;
      const variant = product ? match!.variant : null;
      const options = new URLSearchParams(variant?.options ?? {}).toString();
      return {
        role: part.role,
        sku: part.sku,
        handle,
        title: product
          ? lineDisplayName(handle, product.title, variant?.title)
          : BUILD_ROLES[part.role].label,
        url: `/products/${handle}${options ? `?${options}` : ''}`,
        image: variant?.image ?? product?.images[0] ?? null,
        quantity: part.quantity,
        price: variant?.price ?? null,
        currency: variant?.currency || catalog.currency,
        available: Boolean(variant && variant.availability !== 'sold_out'),
      };
    }),
  }));
}

/** Never silently omit an unavailable part from a requested build. */
export function heroBuildSelection(
  build: HeroBuild,
  selected: ReadonlySet<string>,
  sellable: (handle: string) => boolean,
) {
  const parts = build.parts.filter((part) => selected.has(part.sku));
  const unavailable = parts.some(
    (part) => !part.available || !sellable(part.handle),
  );
  const currency = parts[0]?.currency;
  const priced =
    parts.length > 0 &&
    parts.every(
      (part) =>
        part.price !== null &&
        Number.isFinite(part.price) &&
        part.currency === currency,
    );
  const total = priced
    ? parts.reduce(
        (sum, part) => sum + Math.round(part.price! * 100) * part.quantity,
        0,
      ) / 100
    : null;
  const lines: CartLine[] = parts.map(({sku, quantity}) => ({sku, quantity}));
  return {
    parts,
    total,
    currency,
    available: priced && !unavailable,
    href: cartAddUrl(build.addUrl, lines),
    complete: parts.length === build.parts.length,
  };
}
