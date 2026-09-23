import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  buildLaunchPolicy,
  campaignSkus,
  checkFirstStepPrices,
  checkFlatPrices,
  shipsWithSkus,
  firstStepPrice,
  hasWebhook,
  launchComment,
  launchVars,
  parseArgs,
  plan,
  setTomlVars,
  shopifyHmac,
  unsoldInFeed,
} from '../../scripts/launch-preorders.mjs';
import {tierPrice} from './preorder-campaign.ts';
import {mapShopifyCatalog} from './shopify-storefront.ts';
import {verifyShopifyHmac} from './shopify-webhook.ts';

const preorders = JSON.parse(
  readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'),
) as {skus: Record<string, unknown>; shipsWith: Record<string, unknown>};

const TIERS = [
  {upTo: 100, off: 0.2},
  {upTo: 250, off: 0.1},
];

test('dry run is the default; --apply and --pr are explicit', () => {
  assert.deepEqual(parseArgs([]), {apply: false, pr: 489});
  assert.deepEqual(parseArgs(['--apply', '--pr', '12']), {apply: true, pr: 12});
  assert.throws(() => parseArgs(['--pr', 'x']));
  assert.throws(() => parseArgs(['--force']));
});

test('the campaign lists the 12 preorder SKUs', () => {
  const skus = campaignSkus(preorders);
  assert.equal(skus.length, 12);
  assert.ok(skus.includes('OPENFC-LITE-2020'));
  assert.ok(skus.includes('OPENMOTOR-2207'));
});

test('the 29 accessory and spare SKUs sell as flat-price preorders', () => {
  // stock/product_skus.json lists these ACC-* SKUs with sales_mode preorder.
  const flat = shipsWithSkus(preorders);
  assert.equal(flat.length, 29);
  assert.ok(flat.every((sku) => sku.startsWith('ACC-')));
  assert.ok(flat.includes('ACC-FRM-PAD') && flat.includes('ACC-ANT-DUAL-T'));
  const policy = buildLaunchPolicy(
    ['ACC-OLD', ...campaignSkus(preorders), ...shipsWithSkus(preorders)],
    [...campaignSkus(preorders), ...shipsWithSkus(preorders)],
  ) as Record<string, {saleMode: string}>;
  assert.equal(policy['ACC-PROP-5-HQ-J37'].saleMode, 'preorder');
  assert.equal(policy['ACC-OLD'].saleMode, 'sold_out');
});

test('flat-price check passes accessories without price tiers', () => {
  const problems = checkFlatPrices(
    [
      {sku: 'A', price: 2.5, compareAt: null},
      {sku: 'B', price: 2.5, compareAt: 3},
      {sku: 'C', price: 0, compareAt: null},
    ],
    ['A', 'B', 'C', 'D'],
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^B: compare-at 3.00 above the flat price 2.50/);
  assert.match(problems[1], /^C: no price/);
  assert.match(problems[2], /^D: not on the storefront/);
});

test('the first step price matches the Worker tierPrice', () => {
  for (const retail of [39, 29, 78.5, 12.99]) {
    assert.equal(firstStepPrice(retail, TIERS), tierPrice(retail, TIERS[0].off));
  }
  assert.equal(firstStepPrice(39, TIERS), 31.2);
});

test('price check reports missing, unpriced and mispriced SKUs only', () => {
  const problems = checkFirstStepPrices(
    [
      {sku: 'A', price: 31.2, compareAt: 39},
      {sku: 'B', price: 39, compareAt: 39},
      {sku: 'C', price: 20, compareAt: null},
    ],
    ['A', 'B', 'C', 'D'],
    TIERS,
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^B: price 39.00, first step is 31.20/);
  assert.match(problems[1], /^C: no compare-at/);
  assert.match(problems[2], /^D: not on the storefront/);
});

test('launch policy opens campaign SKUs and keeps the rest closed', () => {
  const policy = buildLaunchPolicy(['ACC-1', 'A', 'B'], ['A', 'B']);
  assert.deepEqual(policy, {
    A: {saleMode: 'preorder', shipPromise: null},
    B: {saleMode: 'preorder', shipPromise: null},
    'ACC-1': {saleMode: 'sold_out', shipPromise: null},
  });
  assert.throws(() => buildLaunchPolicy(['A'], ['A', 'B']), /B/);
});

test('launch policy is accepted by the storefront catalog mapper', () => {
  const variant = (sku: string) => ({
    id: `gid://shopify/ProductVariant/${sku}`,
    sku,
    title: sku,
    availableForSale: true,
    selectedOptions: [],
    price: {amount: '31.20', currencyCode: 'EUR'},
    compareAtPrice: {amount: '39.00', currencyCode: 'EUR'},
    image: null,
  });
  const skus = ['OPENRX-LITE', 'ACC-STRAP-001'];
  const policy = buildLaunchPolicy(skus, ['OPENRX-LITE']);
  const catalog = mapShopifyCatalog(
    {
      products: {
        pageInfo: {hasNextPage: false},
        nodes: [
          {
            handle: 'p',
            title: 'P',
            productType: '',
            description: '',
            featuredImage: null,
            images: {nodes: []},
            variants: {pageInfo: {hasNextPage: false}, nodes: skus.map(variant)},
          },
        ],
      },
    } as unknown as Parameters<typeof mapShopifyCatalog>[0],
    'example.myshopify.com',
    JSON.stringify(policy),
    '1',
  );
  const modes = Object.fromEntries(catalog.products[0].variants.map((v) => [v.sku, v.availability]));
  assert.deepEqual(modes, {'OPENRX-LITE': 'preorder', 'ACC-STRAP-001': 'sold_out'});
});

test('setTomlVars rewrites [vars] only and appends missing keys', () => {
  const toml = [
    'name = "x"',
    'PUBLIC_COMING_SOON = "1"',
    '',
    '[vars]',
    '# comment',
    'SHOPIFY_CHECKOUT_WRITE_ENABLED = "0"',
    'PUBLIC_COMING_SOON = "1"',
    '',
    '[triggers]',
    'crons = []',
  ].join('\n');
  const out = setTomlVars(toml, {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0', PUBLIC_PRELAUNCH: '0'});
  assert.equal(
    out,
    [
      'name = "x"',
      'PUBLIC_COMING_SOON = "1"',
      '',
      '[vars]',
      '# comment',
      'SHOPIFY_CHECKOUT_WRITE_ENABLED = "1"',
      'PUBLIC_COMING_SOON = "0"',
      'PUBLIC_PRELAUNCH = "0"',
      '',
      '[triggers]',
      'crons = []',
    ].join('\n'),
  );
  assert.throws(() => setTomlVars('a = 1', {}), /\[vars\]/);
});

test('the production config opens with the launch vars and nothing else changes', () => {
  const toml = readFileSync(new URL('../../wrangler.production.toml', import.meta.url), 'utf8');
  const out = launchComment(setTomlVars(toml, launchVars({prelaunchFlagInUse: false})));
  assert.match(out, /^SHOPIFY_CHECKOUT_WRITE_ENABLED = "1"$/m);
  assert.match(out, /^PUBLIC_COMING_SOON = "0"$/m);
  assert.doesNotMatch(out, /every commerce write remains closed/);
  const before = toml.slice(0, toml.indexOf('[vars]'));
  assert.equal(out.slice(0, out.indexOf('[vars]')), before);
  assert.deepEqual(Object.keys(launchVars({prelaunchFlagInUse: true})).sort(), [
    'PUBLIC_COMING_SOON',
    'PUBLIC_PRELAUNCH',
    'SHOPIFY_CHECKOUT_WRITE_ENABLED',
  ]);
});

test('webhook is detected by topic and uri', () => {
  const uri = 'https://opendrone.be/api/shopify/orders-paid';
  assert.equal(hasWebhook([{topic: 'ORDERS_PAID', uri}], uri), true);
  assert.equal(hasWebhook([{topic: 'ORDERS_CREATE', uri}], uri), false);
  assert.equal(hasWebhook([], uri), false);
});

test('shopifyHmac signs the way the webhook route verifies', async () => {
  // Reference value: printf '{}' | openssl dgst -sha256 -hmac secret -binary | base64
  assert.equal(shopifyHmac('secret', '{}'), 'dzJZAsrKgS3CWXM6rNBGtzgXNyx3e42VtAJkdHRRbhM=');
  const body = JSON.stringify({line_items: []});
  assert.equal(await verifyShopifyHmac('s3', body, shopifyHmac('s3', body)), true);
  assert.equal(await verifyShopifyHmac('s3', body, shopifyHmac('other', body)), false);
});

test('feed check names campaign SKUs that are not buyable', () => {
  const feed = {
    products: [
      {
        variants: [
          {sku: 'A', available: true, price: '31.20'},
          {sku: 'B', available: false, price: null},
        ],
      },
    ],
  };
  assert.deepEqual(unsoldInFeed(feed, ['A', 'B', 'C']), ['B', 'C']);
});

test('the plan never carries a secret value', () => {
  const text = plan({pr: 489, skus: campaignSkus(preorders)})
    .map(([, t]) => t)
    .join('\n');
  assert.match(text, /SHOPIFY_WEBHOOK_SECRET \(from \.env\)/);
  assert.match(text, /ORDERS_PAID/);
  assert.match(text, /gh pr merge 489 --squash/);
});

test('missingAdminScopes names the scopes holds, tags and price steps need', async () => {
  const {missingAdminScopes} = await import('../../scripts/launch-preorders.mjs');
  const today = ['read_all_orders', 'read_orders', 'write_products', 'read_merchant_managed_fulfillment_orders', 'write_merchant_managed_fulfillment_orders'];
  assert.deepEqual(missingAdminScopes(today), ['write_orders']);
  assert.deepEqual(missingAdminScopes([...today, 'write_orders']), []);
  // write implies read
  assert.deepEqual(missingAdminScopes(['read_all_orders', 'write_orders', 'write_products', 'write_merchant_managed_fulfillment_orders']), []);
});

test('marketPricingProblems accepts the live tax-inclusive setup and names an excluding market', async () => {
  const {marketPricingProblems} = await import('../../scripts/launch-preorders.mjs');
  const inclusive = {inclusiveTaxPricingStrategy: 'INCLUDES_TAXES_IN_PRICE'};
  const live = {
    shop: {taxesIncluded: true},
    markets: {
      nodes: [
        {handle: 'be', enabled: true, priceInclusions: null},
        {handle: 'international', enabled: true, priceInclusions: inclusive},
        {handle: 'us', enabled: true, priceInclusions: inclusive},
      ],
    },
  };
  assert.deepEqual(marketPricingProblems(live), []);
  const us = {handle: 'us', enabled: true, priceInclusions: {inclusiveTaxPricingStrategy: 'EXCLUDES_TAXES_FROM_PRICE'}};
  const problems = marketPricingProblems({shop: {taxesIncluded: false}, markets: {nodes: [us, {...us, handle: 'off', enabled: false}]}});
  assert.equal(problems.length, 2);
  assert.match(problems[0], /Settings > Taxes/);
  assert.match(problems[1], /^market us: /);
});
