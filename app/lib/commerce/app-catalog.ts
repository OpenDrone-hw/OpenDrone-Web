/**
 * The app's `storefront.catalog` snapshot mapped into the `Catalog` of `app/lib/catalog.ts`, so the whole site
 * (header, home, product pages, cart drawer) renders from the app when COMMERCE_SOURCE is 'app' and never calls
 * Shopify. Pure and bundler-free so the node:test suites can load it.
 *
 * One EUR catalog serves every region: no market prices. The app applies the preorder campaign itself: each variant
 * carries `sale_mode` (in_stock, preorder, sold_out), `ship_promise`, `price_minor` at the current step and, for a
 * campaign SKU, `campaign` (the Worker's own CampaignState, assigned as is); the snapshot lists `campaign_skus` and
 * says whether the counts were read (`campaign_counts`). The site maps them where Shopify mode's `applyCampaign` does.
 */
import type {Catalog, CatalogAvailability, CatalogProduct, CatalogVariant} from '../catalog.ts';
import type {CampaignState} from '../preorder-campaign.ts';
import {memoCatalog} from '../catalog-memo.ts';
import type {CatalogClient, CatalogReader} from '../catalog-client.ts';
import {edgeCache, snapshot, type AppEnv} from './app-api.ts';

/** The cart endpoint the buy buttons post to. Kept at the path the buttons already use; in app mode it adds to the
 *  app cart (`app-cart.ts`) instead of creating a Shopify cart. */
export const APP_ADD_PATH = '/api/shopify/cart';
/** The app-backed cart page. */
export const APP_CART_PATH = '/shop/cart';

type WireVariant = {
  id: string;
  sku?: string | null;
  title?: string | null;
  price?: string | null;
  price_minor?: number | null;
  compare_at_minor?: number | null;
  available?: boolean;
  /** The app's sale state; absent from an older app (then `available` alone decides). */
  sale_mode?: 'in_stock' | 'preorder' | 'sold_out';
  ship_promise?: string | null;
  closed_reason?: string | null;
  campaign?: CampaignState | null;
  /** The Shopify variant id a promoted variant came from. */
  alias?: string | null;
  options?: Record<string, string> | null;
  /** The variant's own photo, when the app has it. */
  image?: {url: string; alt?: string | null} | null;
};
type WireProduct = {
  id: string;
  handle: string;
  title: string;
  type?: string | null;
  /** The brand of a third-party part; empty or absent for the house brand. */
  vendor?: string | null;
  description_html?: string | null;
  image?: {url: string; alt?: string | null} | null;
  media?: Array<{url: string; alt?: string | null}> | null;
  variants?: WireVariant[] | null;
};
export type AppCatalogWire = {
  currency?: string;
  products?: WireProduct[];
  version?: string;
  campaign_skus?: string[];
  campaign_counts?: 'verified' | 'unavailable';
};

const SALE_MODES: ReadonlySet<string> = new Set(['in_stock', 'preorder', 'sold_out']);

/** What the variant sells as: the app's `sale_mode`, an unavailable variant always sold out, an older app's `available`. */
export function saleMode(v: Pick<WireVariant, 'available' | 'sale_mode'>): CatalogAvailability {
  if (!v.available) return 'sold_out';
  return v.sale_mode && SALE_MODES.has(v.sale_mode) ? (v.sale_mode as CatalogAvailability) : 'in_stock';
}

/** Plain text of the app's description HTML, for the card and meta description. */
function plain(html: string | null | undefined): string | null {
  const text = (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

type Img = {url: string; alt?: string | null};

function norm(text: string): string {
  return text.toLowerCase().replace(/\u00d7/g, 'x').replace(/\s+/g, ' ').trim();
}

/**
 * The photo of one variant. The app's own `image` wins. Until the app carries variant photos, the first product photo
 * whose alt text names the variant's option value as a whole word ("OpenFC Lite 30x30, front" for 30x30) stands in, so
 * the two sizes of a board do not show the same picture in the grid. No match: the product's first photo.
 */
export function variantImage(variant: WireVariant, images: Img[]): Img | null {
  if (variant.image?.url) return variant.image;
  const values = Object.values(variant.options ?? {}).map(norm).filter(Boolean);
  for (const value of values) {
    const word = new RegExp(`(?<![\\w-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    const hit = images.find((m) => m.alt && word.test(norm(m.alt)));
    if (hit) return hit;
  }
  return images[0] ?? null;
}

export function mapAppCatalog(wire: AppCatalogWire, now: Date = new Date()): Catalog {
  if (!wire || !Array.isArray(wire.products)) throw new Error('app catalog: not a catalog document');
  const currency = wire.currency || 'EUR';
  const products: CatalogProduct[] = wire.products.map((p) => {
    const images = [p.image, ...(p.media ?? [])].filter((m): m is {url: string; alt?: string | null} => Boolean(m?.url));
    const unique = images.filter((m, i) => images.findIndex((x) => x.url === m.url) === i);
    const variants: CatalogVariant[] = (p.variants ?? [])
      .filter((v) => v.sku && v.price_minor != null)
      .map((v) => {
        const price = (v.price_minor as number) / 100;
        const compare = v.compare_at_minor != null ? v.compare_at_minor / 100 : null;
        const sku = v.sku as string;
        const mode = saleMode(v);
        const photo = variantImage(v, unique);
        return {
          sku,
          title: v.title ?? '',
          model: v.options?.Model ?? null,
          options: {...(v.options ?? {})},
          price,
          compare_price: compare,
          currency,
          availability: mode,
          // A closed or in-stock variant promises no date; only a preorder carries the app's ship promise.
          ship_promise: mode === 'preorder' ? v.ship_promise ?? null : null,
          campaign: mode === 'preorder' ? v.campaign ?? null : null,
          image: photo?.url ?? null,
          image_alt: photo?.alt ?? null,
          url: `/products/${p.handle}`,
          cart_add_url: `${APP_ADD_PATH}?sku=${encodeURIComponent(sku)}&qty=1`,
          cart_add_method: 'POST',
          merchandise_id: v.id,
          ...(v.alias ? {alias: v.alias} : {}),
        } as CatalogVariant & {alias?: string};  // alias: the Shopify id, for old ?variant= links (legacy-urls.ts)
      });
    return {
      handle: p.handle,
      title: p.title,
      family: p.type || null,
      vendor: p.vendor?.trim() || null,  // the app sends '' for none; the PDP brand and JSON-LD read it
      description: plain(p.description_html),
      url: `/products/${p.handle}`,
      images: unique.map((m) => m.url),
      image_alts: unique.map((m) => m.alt ?? null),
      rating: null,
      variants,
    };
  });
  return {
    schema: 1,
    generated_at: now.toISOString(),
    max_age: 60,
    currency,
    prices_include_vat: true,
    shop_url: '',
    cart_url: APP_CART_PATH,
    add_url: APP_ADD_PATH,
    add_method: 'POST',
    campaign_skus: Array.isArray(wire.campaign_skus) ? wire.campaign_skus.filter((x) => typeof x === 'string') : [],
    ...(wire.campaign_counts ? {campaign_counts: wire.campaign_counts} : {}),
    products,
  };
}

/** COMMERCE_SOURCE=app: one EUR catalog from the app for every region, no Shopify call; the app applies the campaign. */
export function appCatalogClient(env: AppEnv): CatalogClient {
  const read = async () => mapAppCatalog(await snapshot<AppCatalogWire>(env, 'storefront.catalog', edgeCache()));
  const reader = (load: () => Promise<Catalog>): CatalogReader => ({get: load, forBuyer: load, forRegion: load, region: 'EU'});
  return {...reader(() => memoCatalog('app', read)), fresh: reader(read)};
}
