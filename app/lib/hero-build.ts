import {bySku, cartAddUrl, isEarlyPrice, type BatchOffer, type Catalog, type CartLine} from './catalog.ts';
import {
  partHandle,
  type BuildsConfig,
  type BuildRole,
} from './build-recommendations.ts';
import {lineDisplayName, shortShipPromise} from './product-content.ts';

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
  /** The variant's ship promise, for the line under the build's button. */
  shipPromise: string | null;
  /** The price is an early bird preorder price. */
  early?: boolean;
  /** A board with the buy now or pre-order choice: which offer `price` and
   *  `shipPromise` are. */
  offer?: BatchOffer;
  /** The pre-order beside a buy-now board: its price and ship promise. */
  preorder?: {price: number; shipPromise: string | null};
  /** Units left in the paid batch (batch 1) for this buyer, or null when
   *  the part is not sold from it: the most an express stack may take. */
  left?: number | null;
};

export type HeroBuild = {
  id: string;
  size: string;
  parts: HeroBuildPart[];
  addUrl: string;
  /** Buy now or pre-order is on (`BATCH_CHOICE`): the home shows this build
   *  as one block with the two modes ({@link buildModes}). */
  choice?: boolean;
};

/** Use the same exact SKU recipes as the cart's build suggestions. */
export function resolveHeroBuilds(
  config: BuildsConfig,
  catalog: Catalog,
  choice = false,
): HeroBuild[] {
  return config.builds.map((build) => ({
    id: build.id,
    ...(choice ? {choice} : {}),
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
        shipPromise: variant?.ship_promise ?? null,
        early: isEarlyPrice(variant),
        ...(variant?.offer ? {offer: variant.offer} : {}),
        ...(variant?.offer === 'buy_now' && variant.campaign?.paidStock
          ? {left: Math.max(0, variant.campaign.paidLeft ?? variant.campaign.batchUnits - variant.campaign.batchOrdered)}
          : {}),
        ...(variant?.preorder_offer
          ? {preorder: {price: variant.preorder_offer.price, shipPromise: variant.preorder_offer.ship_promise}}
          : {}),
      };
    }),
  }));
}

/**
 * The FC + ESC of a build as a stack offer for the hero, or null. Only while
 * both boards are in stock on a dated ship promise (the EU's paid batch): a
 * buyer region on a funding target gets no offer, and the card goes away on
 * its own once that batch sells out. Bought with the build's later parts the
 * same boards wait for those, which is why the stack has its own card.
 */
export function heroStack(build: HeroBuild): HeroBuild | null {
  const parts = build.parts.filter(
    (part) => part.role === 'flight-controller' || part.role === 'esc',
  );
  if (parts.length !== 2) return null;
  const dated = parts.every(
    (part) =>
      part.available && shortShipPromise(part.shipPromise)?.kind === 'date',
  );
  return dated ? {...build, id: `${build.id}-stack`, parts} : null;
}

/**
 * Never silently omit an unavailable part from a requested build. While the
 * shop is coming soon (`comingSoon`, the PUBLIC_COMING_SOON gate) no price or
 * total is shown and the cart action becomes the launch-list link.
 */
export function heroBuildSelection(
  build: HeroBuild,
  selected: ReadonlySet<string>,
  sellable: (handle: string) => boolean,
  comingSoon = false,
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
  const total = priced && !comingSoon
    ? parts.reduce(
        (sum, part) => sum + Math.round(part.price! * 100) * part.quantity,
        0,
      ) / 100
    : null;
  const kinds = new Set(parts.map((part) => shortShipPromise(part.shipPromise)?.kind));
  const lines: CartLine[] = parts.map(({sku, quantity}) => ({sku, quantity}));
  return {
    parts,
    total,
    currency,
    available: priced && !unavailable && !comingSoon,
    showPrices: !comingSoon,
    notify: comingSoon,
    href: cartAddUrl(build.addUrl, lines),
    complete: parts.length === build.parts.length,
    shipMix: (kinds.has('target') ? (kinds.has('date') ? 'mixed' : 'target') : kinds.has('date') ? 'date' : 'none') as
      | 'mixed'
      | 'target'
      | 'date'
      | 'none',
  };
}

export type BuildMode = 'buy_now' | 'preorder';

const isBoard = (part: Pick<HeroBuildPart, 'role'>) => part.role === 'flight-controller' || part.role === 'esc';

/**
 * A build as its two modes, each a build of its own whose rows carry that
 * mode's price, so the total of a mode is always the sum of its rows:
 * - `buy_now`: the FC and ESC stack from stock at the retail price, or null
 *   unless both boards are in stock for this buyer;
 * - `preorder`: the full build, the boards at their pre-order price, every
 *   line added as a pre-order (`offer=preorder`), so nothing in it is a
 *   board paid at retail that then waits for March.
 */
export function buildModes(build: HeroBuild): {buy_now: HeroBuild | null; preorder: HeroBuild} {
  const boards = build.parts.filter(isBoard);
  const stocked = boards.length === 2 && boards.every((part) => part.offer === 'buy_now' && part.available);
  return {
    buy_now: stocked ? {...build, id: `${build.id}-stack`, parts: boards} : null,
    preorder: {
      ...build,
      parts: build.parts.map((part) =>
        part.offer !== 'buy_now'
          ? part
          : part.preorder
            ? {...part, offer: 'preorder' as const, price: part.preorder.price, shipPromise: part.preorder.shipPromise}
            // In stock but its pre-order is closed: not part of a pre-order build.
            : {...part, available: false},
      ),
    },
  };
}

/** The add link of a mode: a pre-order build asks for the pre-order offer. */
export function modeAddUrl(href: string, mode: BuildMode): string {
  return mode === 'preorder' ? `${href}${href.includes('?') ? '&' : '?'}offer=preorder` : href;
}

/** The FC and ESC stack a buyer can buy now, as the express offer: its
 *  lines per stack, its price per stack and the most stacks batch 1 still
 *  holds. Null unless both boards are in stock for this buyer. */
export function stackOffer(build: HeroBuild): {
  size: string;
  parts: HeroBuildPart[];
  lines: Array<{sku: string; quantity: number}>;
  price: number;
  currency: string;
  max: number;
} | null {
  const stack = buildModes(build).buy_now;
  if (!stack || stack.parts.some((part) => part.price === null)) return null;
  const price = stack.parts.reduce((sum, part) => sum + Math.round(part.price! * 100) * part.quantity, 0) / 100;
  const max = Math.min(...stack.parts.map((part) => Math.floor((part.left ?? Infinity) / part.quantity)));
  if (!(max > 0)) return null;
  return {
    size: build.size,
    parts: stack.parts,
    lines: stack.parts.map((part) => ({sku: part.sku, quantity: part.quantity})),
    price,
    currency: stack.parts[0].currency,
    max,
  };
}

/** The `lines` field of an express purchase: each line times the quantity. */
export function expressLinesField(lines: ReadonlyArray<{sku: string; quantity: number}>, quantity: number): string {
  return lines.map((line) => `${line.sku}:${line.quantity * quantity}`).join(',');
}
