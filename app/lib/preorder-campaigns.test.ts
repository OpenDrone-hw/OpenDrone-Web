import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCampaigns,
  otherProducts,
  productPath,
  summarize,
} from './preorder-campaigns.ts';
import {parseCatalog, type Catalog} from './catalog.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/preorder-campaigns.test.ts
//
// The crowdfunding page is the one surface that can offer to take money for
// a campaign, so the two things tested hardest here are that a MISSED
// campaign can never produce an orderable tier, and that a figure the feed
// does not carry is reported as absent rather than as zero.

const NOW = Date.parse('2026-11-20T09:00:00Z');

type RawFunding = Record<string, unknown>;

function variant(overrides: Record<string, unknown> = {}) {
  return {
    sku: 'OD-RX-20',
    title: 'Gemini 20x20',
    model: 'Gemini',
    options: {Model: 'Gemini'},
    price: 39.9,
    compare_price: 49.9,
    currency: 'EUR',
    availability: 'preorder',
    ship_promise: 'Ships about 10 weeks after the target is reached',
    discount: {label: 'Early bird', ends_at: null, units_left: 40},
    image: null,
    url: 'https://shop.incutec.com/shop/openrx-gemini',
    cart_add_url: 'https://shop.incutec.com/incutec/add?sku=OD-RX-20&qty=1&next=cart',
    ...overrides,
  };
}

function product(
  handle: string,
  funding: RawFunding | null,
  variants: Array<Record<string, unknown>> = [variant()],
) {
  return {
    handle,
    title: handle,
    family: null,
    description: null,
    url: `https://shop.incutec.com/shop/${handle}`,
    images: ['https://erp.incutec.com/web/image/1'],
    rating: null,
    variants: variants.map((entry) => ({
      campaign_target: funding?.target_units ?? null,
      campaign_units_funded: funding?.units_funded ?? null,
      ...entry,
    })),
    funding,
  };
}

function catalogOf(products: Array<ReturnType<typeof product>>): Catalog {
  return parseCatalog({
    schema: 2,
    generated_at: '2026-11-20T00:00:00Z',
    max_age: 300,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: 'https://shop.incutec.com',
    cart_url: 'https://shop.incutec.com/shop/cart',
    add_url: 'https://shop.incutec.com/incutec/add',
    products,
  });
}

const open2: RawFunding = {
  target_units: 500,
  units_funded: 312,
  pct: 62.4,
  state: 'open',
  date_open: '2026-09-01',
  date_deadline: '2026-12-01',
  backers: 288,
  amount_funded: 12448.8,
  currency: 'EUR',
};

describe('buildCampaigns', () => {
  it('builds one campaign per public campaign, in catalog order', () => {
    const catalog = catalogOf([
      product('openrx', open2),
      product('openfc', {...open2, state: 'funded', units_funded: 500}),
      product('props', null),
    ]);
    const campaigns = buildCampaigns(catalog, NOW);
    assert.deepEqual(
      campaigns.map((c) => c.handle),
      ['openrx', 'openfc'],
    );
    assert.equal(campaigns[0].to, '/products/openrx');
    assert.equal(productPath('openrx'), '/products/openrx');
  });

  it('never shows a draft or cancelled campaign', () => {
    const catalog = catalogOf([
      product('draft-board', {...open2, state: 'draft'}),
      product('pulled-board', {...open2, state: 'cancelled'}),
    ]);
    assert.deepEqual(buildCampaigns(catalog, NOW), []);
    // They are still products, so they fall through to the plain list.
    assert.deepEqual(
      otherProducts(catalog).map((p) => p.handle),
      ['draft-board', 'pulled-board'],
    );
  });

  it('caps the bar at 100 while the label keeps the real count', () => {
    const catalog = catalogOf([
      product('openrx', {...open2, units_funded: 700, state: 'funded'}),
    ]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.equal(campaign.pct, 100);
    assert.equal(campaign.unitsLabel, '700 of 500 units');
  });

  it('counts days only while the campaign is open', () => {
    const catalog = catalogOf([
      product('openrx', open2),
      product('openfc', {...open2, state: 'funded'}),
      product('openesc', {...open2, state: 'missed'}),
    ]);
    const [live, funded, missed] = buildCampaigns(catalog, NOW);
    assert.equal(live.daysLeft, 11);
    // A closed campaign has no countdown: the state chip replaces it.
    assert.equal(funded.daysLeft, null);
    assert.equal(missed.daysLeft, null);
    assert.equal(funded.statusText, 'Funded');
    assert.equal(missed.statusText, 'Funding missed');
  });

  it('reports a figure the feed omits as absent, never as zero', () => {
    const schema1 = {target_units: 500, units_funded: 312, pct: 62.4, state: 'open'};
    const catalog = catalogOf([product('openrx', schema1)]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.equal(campaign.amountFunded, null);
    assert.equal(campaign.backers, null);
    assert.equal(campaign.daysLeft, null);
    // Currency still resolves, from the catalog document.
    assert.equal(campaign.currency, 'EUR');
  });

  it('builds a tier per variant with its price, discount and hand-off', () => {
    const catalog = catalogOf([
      product('openrx', open2, [variant(), variant({sku: 'OD-RX-30', title: 'Gemini 30x30'})]),
    ]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.equal(campaign.tiers.length, 2);
    const [tier] = campaign.tiers;
    assert.equal(tier.sku, 'OD-RX-20');
    assert.equal(tier.price.amount, '39.90');
    assert.equal(tier.compareAtPrice?.amount, '49.90');
    assert.equal(tier.discountLabel, 'Early bird');
    assert.equal(tier.unitsLeft, 40);
    assert.match(tier.shipPromise ?? '', /about 10 weeks/);
    assert.match(tier.cartAddUrl, /\/incutec\/add\?/);
    assert.match(tier.cartAddUrl, /next=cart/);
    assert.equal(tier.orderable, true);
    assert.equal(tier.ctaLabel, 'Add to cart');
  });

  it('drops a compare price that is not above the price', () => {
    const catalog = catalogOf([
      product('openrx', open2, [variant({compare_price: 39.9})]),
    ]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.equal(campaign.tiers[0].compareAtPrice, null);
  });

  it('disables every tier of a missed campaign', () => {
    // The money is being refunded: no tier of it may be orderable, whatever
    // the availability word on the variant still says.
    const catalog = catalogOf([
      product('openrx', {...open2, state: 'missed'}, [
        variant({availability: 'in_stock'}),
      ]),
    ]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.equal(campaign.tiers[0].orderable, false);
    assert.equal(campaign.tiers[0].ctaLabel, 'Funding missed');
  });

  it('disables a sold-out variant of a running campaign', () => {
    const catalog = catalogOf([
      product('openrx', open2, [variant({availability: 'sold_out'})]),
    ]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.equal(campaign.tiers[0].orderable, false);
    assert.equal(campaign.tiers[0].ctaLabel, 'Not available');
  });

  it('renders a campaign that has no variants at all', () => {
    const catalog = catalogOf([product('openrx', open2, [])]);
    const [campaign] = buildCampaigns(catalog, NOW);
    assert.deepEqual(campaign.tiers, []);
    assert.equal(campaign.unitsLabel, '312 of 500 units');
  });

  it('is empty for an empty catalog', () => {
    const catalog = catalogOf([]);
    assert.deepEqual(buildCampaigns(catalog, NOW), []);
    assert.deepEqual(otherProducts(catalog), []);
  });
});

describe('summarize', () => {
  it('adds up the round', () => {
    const catalog = catalogOf([
      product('openrx', open2),
      product('openfc', {
        ...open2,
        state: 'funded',
        units_funded: 500,
        amount_funded: 20000,
        backers: 460,
        date_deadline: '2026-11-25',
      }),
    ]);
    const summary = summarize(buildCampaigns(catalog, NOW), 'EUR');
    assert.equal(summary.amountFunded, 32448.8);
    assert.equal(summary.backers, 748);
    assert.equal(summary.funded, 1);
    assert.equal(summary.open, 1);
    assert.equal(summary.total, 2);
    // Only an OPEN campaign has a deadline still running.
    assert.equal(summary.daysLeft, 11);
  });

  it('leaves a missed campaign out of the money and the backers', () => {
    // Those preorders are refunded in full, so that money was not raised.
    const catalog = catalogOf([
      product('openrx', open2),
      product('openesc', {
        ...open2,
        state: 'missed',
        amount_funded: 4000,
        backers: 90,
      }),
    ]);
    const summary = summarize(buildCampaigns(catalog, NOW), 'EUR');
    assert.equal(summary.amountFunded, 12448.8);
    assert.equal(summary.backers, 288);
    assert.equal(summary.total, 2);
    assert.equal(summary.funded, 0);
    assert.equal(summary.open, 1);
  });

  it('takes the nearest open deadline', () => {
    const catalog = catalogOf([
      product('openrx', open2),
      product('openfc', {...open2, date_deadline: '2026-11-23'}),
    ]);
    const summary = summarize(buildCampaigns(catalog, NOW), 'EUR');
    assert.equal(summary.daysLeft, 3);
  });

  it('says nothing it was not told', () => {
    const schema1 = {target_units: 500, units_funded: 312, pct: 62.4, state: 'open'};
    const catalog = catalogOf([product('openrx', schema1)]);
    const summary = summarize(buildCampaigns(catalog, NOW), 'EUR');
    assert.equal(summary.amountFunded, 0);
    assert.equal(summary.backers, null);
    assert.equal(summary.daysLeft, null);
    assert.equal(summary.currency, 'EUR');
  });

  it('degrades to an empty round', () => {
    const summary = summarize([], 'EUR');
    assert.deepEqual(summary, {
      amountFunded: 0,
      currency: 'EUR',
      backers: null,
      funded: 0,
      open: 0,
      total: 0,
      daysLeft: null,
    });
  });
});
