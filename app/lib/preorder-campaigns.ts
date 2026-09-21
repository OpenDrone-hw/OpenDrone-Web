/**
 * The crowdfunding page's view of the catalog: one campaign per product
 * that has a public funding campaign, one tier per variant of it, and the
 * summary strip above them all.
 *
 * Every number here is derived in the loader and shipped to the browser
 * already computed. That is deliberate for the day counts: a count taken
 * during render is the server's day on the first paint and the visitor's
 * day on hydration, which is a React mismatch on the line a buyer is
 * reading (see `fundingDaysLeft`).
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it without Vite, the same constraint as
 * `catalog.ts` and `funding.ts`.
 */

// Relative imports on purpose: node:test runs this module without Vite, so
// the `~` alias is not available here.
import {toProduct, type Catalog, type CatalogFunding} from './catalog.ts';
import type {MoneyV2, ProductImage} from './product-shapes.ts';
import {
  fundingDaysLeft,
  fundingDisplayPct,
  fundingStatusText,
  fundingUnitsLabel,
  isFundingPublic,
} from './funding.ts';

/** A campaign state a buyer is allowed to see. */
export type PublicFundingState = 'open' | 'funded' | 'missed';

/** One buyable variant of a campaign product. */
export type PreorderTier = {
  sku: string;
  title: string;
  image: ProductImage | null;
  price: MoneyV2;
  /** Struck-through price, only when the feed carries a higher one. */
  compareAtPrice: MoneyV2 | null;
  /** The promotion's own wording, for the chip beside the price. */
  discountLabel: string | null;
  /** Units left at the discounted price, or null when uncapped/absent. */
  unitsLeft: number | null;
  /** Paid Shopify units toward this SKU's production-run goal. */
  unitsFunded: number | null;
  targetUnits: number | null;
  shipPromise: string | null;
  /** The shop hand-off link (POST to `<shop>/incutec/add`, `next=cart`). */
  cartAddUrl: string;
  /** False disables the button; `ctaLabel` then says why. */
  orderable: boolean;
  ctaLabel: string;
};

/** One product with a public campaign, as the tracker and tiers read it. */
export type PreorderCampaign = {
  handle: string;
  title: string;
  /** This site's product page, not the shop's. */
  to: string;
  image: ProductImage | null;
  state: PublicFundingState;
  /** Status word from the shared helper ("Funding open", "Funded", ...). */
  statusText: string;
  /** Bar width and `aria-valuenow`, capped at 100. */
  pct: number;
  /** Exactly "X of Y units". */
  unitsLabel: string;
  unitsFunded: number;
  targetUnits: number;
  /** Money pledged, or null when the feed does not carry it. */
  amountFunded: number | null;
  currency: string;
  backers: number | null;
  /** Whole days to the deadline, 0 once past, null without a deadline. */
  daysLeft: number | null;
  tiers: PreorderTier[];
};

/** A product with no campaign, listed as a plain link. */
export type OtherProduct = {handle: string; title: string; to: string};

/** The hero strip: every public campaign added up. */
export type PreorderSummary = {
  /** Pledged across campaigns still standing (open or funded). A missed
   *  campaign is refunded in full, so its money is not "raised". */
  amountFunded: number;
  currency: string;
  /** Backers across those same campaigns, null when no feed carries any. */
  backers: number | null;
  /** How many SKU goals reached their target. */
  funded: number;
  /** How many SKU goals are still taking orders. */
  open: number;
  /** Public SKU goals in total, missed ones included. */
  total: number;
  /** Days to the nearest OPEN deadline, or null when none is running. */
  daysLeft: number | null;
};

const PREORDER_CTA = 'Add to cart';
const MISSED_CTA = 'Funding missed';
const UNAVAILABLE_CTA = 'Not available';

/** This site's product page for a handle. */
export function productPath(handle: string): string {
  return `/products/${handle}`;
}

function tiersOf(
  catalog: Catalog,
  handle: string,
  state: PublicFundingState,
): PreorderTier[] {
  const product = catalog.products.find((p) => p.handle === handle);
  if (!product) return [];
  // One mapping, the same one the product page uses: prices, compare
  // prices, discounts and hand-off links all arrive already normalized.
  return toProduct(catalog, product).variants.nodes.map((variant) => {
    // A missed campaign is refunded, not ordered: the button is dead on
    // every tier of it regardless of what availability says.
    const orderable =
      state !== 'missed' && variant.availableForSale && Boolean(variant.cartAddUrl);
    return {
      sku: variant.sku ?? '',
      title: variant.title,
      image: variant.image,
      price: variant.price,
      compareAtPrice: variant.compareAtPrice,
      discountLabel: variant.discount?.label ?? null,
      unitsLeft: variant.discount?.unitsLeft ?? null,
      unitsFunded: variant.campaignUnitsFunded ?? null,
      targetUnits: variant.campaignTarget ?? null,
      shipPromise: variant.shipPromise ?? null,
      cartAddUrl: variant.cartAddUrl,
      orderable,
      ctaLabel: orderable
        ? PREORDER_CTA
        : state === 'missed'
          ? MISSED_CTA
          : UNAVAILABLE_CTA,
    };
  });
}

/**
 * Every product whose campaign a buyer may see, in catalog order.
 *
 * `draft` and `cancelled` campaigns are not campaigns as far as this page
 * is concerned (`isFundingPublic`), so they fall through to
 * `otherProducts` as ordinary products.
 */
export function buildCampaigns(
  catalog: Catalog,
  now: number = Date.now(),
): PreorderCampaign[] {
  return catalog.products
    .filter((product) => isFundingPublic(product.funding))
    .map((product) => {
      const funding = product.funding as CatalogFunding;
      const state = funding.state as PublicFundingState;
      const mapped = toProduct(catalog, product);
      return {
        handle: product.handle,
        title: product.title,
        to: productPath(product.handle),
        image: mapped.images.nodes[0] ?? mapped.featuredImage ?? null,
        state,
        statusText: fundingStatusText(funding),
        pct: fundingDisplayPct(funding),
        unitsLabel: fundingUnitsLabel(funding),
        unitsFunded: funding.unitsFunded,
        targetUnits: funding.targetUnits,
        amountFunded: funding.amountFunded ?? null,
        currency: funding.currency ?? catalog.currency,
        backers: funding.backers ?? null,
        // A closed campaign has no countdown left to run: the state chip
        // replaces it on the card, so the number is not computed for one.
        daysLeft: state === 'open' ? fundingDaysLeft(funding, now) : null,
        tiers: tiersOf(catalog, product.handle, state),
      };
    });
}

/** Products with no public campaign, for the small "Other products" list. */
export function otherProducts(catalog: Catalog): OtherProduct[] {
  return catalog.products
    .filter((product) => !isFundingPublic(product.funding))
    .map((product) => ({
      handle: product.handle,
      title: product.title,
      to: productPath(product.handle),
    }));
}

/**
 * The hero strip. Sums only what the feed actually carries: with no
 * `amount_funded` anywhere the total is 0 and the page says nothing about
 * money rather than inventing a figure from unit counts and prices.
 */
export function summarize(
  campaigns: PreorderCampaign[],
  fallbackCurrency: string,
): PreorderSummary {
  const standing = campaigns.filter((c) => c.state !== 'missed');
  const skuGoals = campaigns.flatMap((campaign) =>
    campaign.tiers
      .filter((tier) => tier.targetUnits != null && tier.unitsFunded != null)
      .map((tier) => ({campaign, tier})),
  );
  const amountFunded = standing.reduce((sum, c) => sum + (c.amountFunded ?? 0), 0);
  const withBackers = standing.filter((c) => c.backers != null);
  const deadlines = campaigns
    .filter((c) => c.state === 'open' && c.daysLeft != null)
    .map((c) => c.daysLeft as number);
  return {
    amountFunded,
    currency: standing[0]?.currency ?? campaigns[0]?.currency ?? fallbackCurrency,
    backers: withBackers.length
      ? withBackers.reduce((sum, c) => sum + (c.backers ?? 0), 0)
      : null,
    funded: skuGoals.filter(
      ({tier}) => (tier.unitsFunded as number) >= (tier.targetUnits as number),
    ).length,
    open: skuGoals.filter(
      ({campaign, tier}) =>
        campaign.state === 'open' &&
        (tier.unitsFunded as number) < (tier.targetUnits as number),
    ).length,
    total: skuGoals.length,
    daysLeft: deadlines.length ? Math.min(...deadlines) : null,
  };
}
