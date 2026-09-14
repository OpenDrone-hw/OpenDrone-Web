#!/usr/bin/env node
/**
 * Write docs/store-snapshot.json: the committed record of the Shopify
 * configuration (shop basics, locations, products, variants, markets,
 * delivery profiles). Read-only; contains no secrets, stock levels, costs
 * or discount codes: nothing beyond what the public storefront shows.
 * Keys are sorted and lists ordered so re-runs diff cleanly. Sections the
 * token cannot read are recorded as {"unavailable": "..."} instead of failing.
 *
 *   npm run snapshot:store
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {admin, VERSION} from './_client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(here, '../../docs/store-snapshot.json');

/** Run a query; on an access-scope refusal return the unavailable marker. */
async function section(scope, query, pick) {
  try {
    return pick(await admin(query));
  } catch (error) {
    if (/Access denied/i.test(String(error.message))) {
      return {unavailable: `scope ${scope} missing`};
    }
    throw error;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name));

const shopData = await admin(`#graphql
  {
    shop { name myshopifyDomain currencyCode taxesIncluded shipsToCountries }
    locations(first: 20) {
      nodes { id name isActive fulfillsOnlineOrders address { city countryCode } }
    }
  }`);

const products = [];
let after = null;
do {
  const data = await admin(
    `#graphql
    query SnapshotProducts($after: String) {
      products(first: 25, after: $after, sortKey: ID) {
        nodes {
          id handle title status productType vendor
          options { name values }
          variants(first: 100) {
            nodes {
              id sku title price compareAtPrice inventoryPolicy
              inventoryItem {
                tracked requiresShipping harmonizedSystemCode countryCodeOfOrigin
                measurement { weight { value unit } }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    {after},
  );
  for (const p of data.products.nodes) {
    products.push({
      id: p.id,
      handle: p.handle,
      title: p.title,
      status: p.status,
      productType: p.productType,
      vendor: p.vendor,
      options: p.options.map((o) => ({name: o.name, values: o.values})),
      variants: p.variants.nodes
        .map((v) => ({
          id: v.id,
          sku: v.sku,
          title: v.title,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          inventoryPolicy: v.inventoryPolicy,
          tracked: v.inventoryItem.tracked,
          requiresShipping: v.inventoryItem.requiresShipping,
          weight: v.inventoryItem.measurement.weight,
          harmonizedSystemCode: v.inventoryItem.harmonizedSystemCode,
          countryCodeOfOrigin: v.inventoryItem.countryCodeOfOrigin,
        }))
        .sort(
          (a, b) =>
            (a.sku ?? '~').localeCompare(b.sku ?? '~') ||
            a.title.localeCompare(b.title),
        ),
    });
  }
  after = data.products.pageInfo.hasNextPage
    ? data.products.pageInfo.endCursor
    : null;
} while (after);
products.sort((a, b) => a.handle.localeCompare(b.handle));

const markets = await section(
  'read_markets',
  `#graphql
  {
    markets(first: 50) {
      nodes {
        id name handle status type
        currencySettings { baseCurrency { currencyCode } }
        conditions {
          regionsCondition {
            regions(first: 100) { nodes { ... on MarketRegionCountry { code name } } }
          }
        }
      }
    }
  }`,
  (data) =>
    data.markets.nodes
      .map((m) => ({
        id: m.id,
        name: m.name,
        handle: m.handle,
        status: m.status,
        type: m.type,
        currency: m.currencySettings?.baseCurrency?.currencyCode ?? null,
        countries: (m.conditions?.regionsCondition?.regions?.nodes ?? [])
          .map((r) => r.code)
          .filter(Boolean)
          .sort(),
      }))
      .sort(byName),
);

const deliveryProfiles = await section(
  'read_shipping',
  `#graphql
  {
    deliveryProfiles(first: 5) {
      nodes {
        id name default
        profileLocationGroups {
          locationGroup { locations(first: 5) { nodes { name } } }
          locationGroupZones(first: 10) {
            nodes {
              zone { name countries { name code { countryCode restOfWorld } provinces { code } } }
              methodDefinitions(first: 10) {
                nodes {
                  name active description
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { price { amount currencyCode } }
                    ... on DeliveryParticipant {
                      carrierService { name } fixedFee { amount currencyCode } percentageOfRateFee
                    }
                  }
                  methodConditions {
                    field operator
                    conditionCriteria {
                      __typename
                      ... on MoneyV2 { amount currencyCode }
                      ... on Weight { value unit }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`,
  (data) =>
    data.deliveryProfiles.nodes
      .map((p) => ({
        id: p.id,
        name: p.name,
        default: p.default,
        locationGroups: p.profileLocationGroups.map((g) => ({
          locations: g.locationGroup.locations.nodes.map((l) => l.name).sort(),
          zones: g.locationGroupZones.nodes
            .map((z) => ({
              name: z.zone.name,
              countries: z.zone.countries
                .map((c) => ({
                  name: c.name,
                  code: c.code.restOfWorld
                    ? 'REST_OF_WORLD'
                    : c.code.countryCode,
                  provinces: c.provinces.map((pr) => pr.code).sort(),
                }))
                .sort(byName),
              rates: z.methodDefinitions.nodes
                .map((m) => ({
                  name: m.name,
                  active: m.active,
                  description: m.description,
                  rateProvider: m.rateProvider,
                  conditions: m.methodConditions,
                }))
                .sort(byName),
            }))
            .sort(byName),
        })),
      }))
      .sort(byName),
);

const snapshot = sortKeys({
  apiVersion: VERSION,
  shop: {
    name: shopData.shop.name,
    myshopifyDomain: shopData.shop.myshopifyDomain,
    currencyCode: shopData.shop.currencyCode,
    taxesIncluded: shopData.shop.taxesIncluded,
    shipsToCountries: [...shopData.shop.shipsToCountries].sort(),
  },
  locations: shopData.locations.nodes
    .map((l) => ({
      id: l.id,
      name: l.name,
      isActive: l.isActive,
      fulfillsOnlineOrders: l.fulfillsOnlineOrders,
      city: l.address?.city ?? null,
      countryCode: l.address?.countryCode ?? null,
    }))
    .sort(byName),
  products,
  markets,
  deliveryProfiles,
});

fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
const unavailable = ['markets', 'deliveryProfiles'].filter(
  (k) => snapshot[k]?.unavailable,
);
console.log(
  `OK: wrote ${path.relative(process.cwd(), outPath)} (${products.length} products` +
    (unavailable.length ? `; unavailable: ${unavailable.join(', ')}` : '') +
    ')',
);
