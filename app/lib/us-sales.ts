/**
 * US consumer preorders: the `PUBLIC_US_SALES` gate plus the flat US
 * shipping rate in `content/us-sales.json`. Both must be set for the US to
 * be sold direct; a missing rate keeps it closed (fail closed). Vite and
 * node:test read the same data.
 */

import type {Catalog, CatalogVariant} from './catalog.ts';
import {priceLadder, tiersFor, type CampaignConfig, type UsdLadderStep} from './preorder-campaign.ts';

export type UsSalesFile = {
  rate?: number | null;
  /** Percentage on top of the EUR VAT-inclusive price, set on the Shopify US
   *  price list (`npm run us:prices`). Shopify converts and rounds. */
  priceUpliftPct?: number;
};

function loadUsSales(): UsSalesFile {
  if (import.meta.env) {
    const files = import.meta.glob<{default: UsSalesFile}>('/content/us-sales.json', {eager: true});
    return Object.values(files)[0]?.default ?? {};
  }
  // node:test: no bundler, read the same file.
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  // A joined path, so Vite does not emit the raw file as a public asset.
  return fs ? (JSON.parse(fs.readFileSync(new URL(['..', '..', 'content', 'us-sales.json'].join('/'), import.meta.url), 'utf8')) as UsSalesFile) : {};
}

/** The US sales settings as committed. */
export const US_SALES: UsSalesFile = loadUsSales();

/**
 * The flat US shipping rate in USD when US consumer sales are open, else
 * null: the gate `PUBLIC_US_SALES` is exactly "1" and the committed rate is
 * a finite, non-negative number. Every US decision (quote, cart, catalog,
 * copy) reads this one answer.
 */
export function usSalesRate(
  env: {PUBLIC_US_SALES?: string} | null | undefined,
  file: UsSalesFile = US_SALES,
): number | null {
  if (env?.PUBLIC_US_SALES !== '1') return null;
  const rate = file.rate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

/** A EUR price and the USD price Shopify's US market showed for it. */
export type UsdSample = {eur: number; usd: number};

/**
 * The band of effective EUR to USD factors (uplift and Shopify's FX)
 * consistent with every live sample, and the rounding Shopify applied.
 * Shopify converts each EUR price and rounds it to whole dollars; the live
 * data rounds up (`ceil`), and `round` (to nearest) is tried when that does
 * not fit. Null when no factor explains all samples: the ladder is then not
 * shown rather than guessed.
 */
export type UsdBand = {lo: number; hi: number; mode: 'ceil' | 'round'};

export function usdBand(samples: UsdSample[]): UsdBand | null {
  const valid = samples.filter((s) => s.eur > 0 && Number.isFinite(s.eur) && Number.isFinite(s.usd));
  if (!valid.length) return null;
  for (const mode of ['ceil', 'round'] as const) {
    // ceil: usd - 1 < eur * k <= usd. round: usd - 0.5 <= eur * k < usd + 0.5.
    const below = mode === 'ceil' ? 1 : 0.5;
    const above = mode === 'ceil' ? 0 : 0.5;
    const lo = Math.max(...valid.map((s) => (s.usd - below) / s.eur));
    const hi = Math.min(...valid.map((s) => (s.usd + above) / s.eur));
    if (lo < hi) return {lo, hi, mode};
  }
  return null;
}

function roundUsd(value: number, mode: UsdBand['mode'], edge: 'lo' | 'hi'): number {
  // The lower bound is exclusive for ceil and inclusive for round.
  const eps = 1e-9;
  const x = mode === 'ceil' ? (edge === 'lo' ? value + eps : value - eps) : value;
  return mode === 'ceil' ? Math.ceil(x) : Math.round(x);
}

/**
 * A EUR price as Shopify's US market would show it: exact when every factor
 * in the band rounds to the same whole dollars, otherwise a mid estimate
 * flagged `approx` ("about US$X").
 */
export function usdOf(eur: number, band: UsdBand): {price: number; approx: boolean} {
  const a = roundUsd(eur * band.lo, band.mode, 'lo');
  const b = roundUsd(eur * band.hi, band.mode, 'hi');
  if (a === b) return {price: a, approx: false};
  return {price: roundUsd((eur * (band.lo + band.hi)) / 2, band.mode, 'hi'), approx: true};
}

/**
 * The USD price ladder of a campaign SKU: each EUR step through
 * {@link usdOf}. The step the next unit falls into is Shopify's live US
 * price, never an estimate.
 */
export function usdLadder(
  retailEur: number,
  tiers: Parameters<typeof priceLadder>[1],
  band: UsdBand,
  nextUnit: number,
  livePrice: number,
): UsdLadderStep[] {
  return priceLadder(retailEur, tiers).map((step) => {
    const current = nextUnit >= step.from && (step.to === null || nextUnit <= step.to);
    if (current) return {...step, price: livePrice, approx: false};
    return {...step, ...usdOf(step.price, band)};
  });
}

/**
 * The campaign-aware catalog (EUR, campaign applied for the US region)
 * with Shopify's US market prices laid over it: each variant's price,
 * compare-at price and currency from `market` (the `@inContext(country: US)`
 * read, USD, no EU VAT). The price-step check already ran on the EUR
 * catalog. A campaign's price is Shopify's US price. Shopify rounds every US
 * market price itself, so a later USD step is derived from the live EUR to
 * USD band ({@link usdBand}) and marked `approx` unless every factor in the
 * band gives the same whole dollars.
 *
 * Fail closed: without a market read, and for a variant the US market does
 * not price in USD or does not sell, the variant is sold out.
 */
export function withMarketPrices(
  catalog: Catalog,
  market: Catalog | null,
  config: CampaignConfig | null = null,
): Catalog {
  const priced = new Map<string, CatalogVariant>();
  for (const product of market?.products ?? []) {
    for (const variant of product.variants) priced.set(variant.sku, variant);
  }
  // Every EUR price next to the USD price Shopify showed for it: the band
  // of EUR to USD factors that explains all of them prices the other steps.
  const samples: UsdSample[] = [];
  for (const product of catalog.products) {
    for (const variant of product.variants) {
      const us = priced.get(variant.sku);
      if (!us || us.currency !== 'USD') continue;
      samples.push({eur: variant.price, usd: us.price});
      if (variant.compare_price != null && us.compare_price != null) {
        samples.push({eur: variant.compare_price, usd: us.compare_price});
      }
    }
  }
  const band = usdBand(samples);
  const closed = (variant: CatalogVariant): CatalogVariant => ({
    ...variant,
    availability: 'sold_out',
    ship_promise: null,
    campaign: null,
  });
  // No US read at all: every variant closed, in the EUR catalog's terms.
  if (!market) {
    return {...catalog, products: catalog.products.map((p) => ({...p, variants: p.variants.map(closed)}))};
  }
  return {
    ...catalog,
    currency: 'USD',
    prices_include_vat: false,
    products: catalog.products.map((product) => ({
      ...product,
      variants: product.variants.map((variant): CatalogVariant => {
        const us = priced.get(variant.sku);
        if (!us || us.currency !== 'USD') return closed(variant);
        // Not for sale in the US market: closed, at its US price.
        if (us.availability === 'sold_out') {
          return {...closed(variant), price: us.price, compare_price: us.compare_price, currency: 'USD'};
        }
        // Shopify rounds each US market price on its own, so a later step's
        // USD price cannot be derived here: the next price is left out and
        // the current one is Shopify's.
        // The ladder's other steps are the EUR steps through the band above.
        const tiers = config && variant.campaign ? tiersFor(config, variant.sku) : [];
        const usLadder =
          variant.campaign && band && tiers.length && variant.compare_price != null && variant.compare_price > 0
            ? usdLadder(variant.compare_price, tiers, band, variant.campaign.ordered + 1, us.price)
            : undefined;
        const campaign = variant.campaign
          ? {...variant.campaign, price: us.price, nextPrice: null, ...(usLadder ? {usLadder} : {})}
          : variant.campaign;
        return {
          ...variant,
          price: us.price,
          compare_price: us.compare_price,
          currency: 'USD',
          ...(campaign !== undefined ? {campaign} : {}),
        };
      }),
    })),
  };
}
