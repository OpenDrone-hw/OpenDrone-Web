#!/usr/bin/env node
/**
 * Create the two discount codes for the end-to-end order test (a contributor
 * in Germany orders one OpenRX Gemini for free, shipping included):
 *   product discount   100% off the OPENRX-GEMINI variant, 1 use, 1 per customer
 *   shipping discount  free shipping to all countries, 1 use
 * Both combine with each other and end 2026-12-31.
 *
 * The codes are secrets and live only in Shopify: each is generated at
 * runtime as DEV-<8 random uppercase alphanumerics> unless
 * SAMPLE_DISCOUNT_CODE / SAMPLE_SHIP_CODE are set in the environment. They
 * are printed once to stdout and never written to a file. Idempotent by
 * discount title: a re-run reports the existing discounts and their codes.
 *
 *   node scripts/shopify-infra/dev-sample-discount.mjs
 * Prints one "<code> <discount node id>" line per discount.
 */

import {randomBytes} from 'node:crypto';
import {admin, assertNoUserErrors} from './_client.mjs';

const ENDS_AT = '2026-12-31T23:59:59+01:00';
const PRODUCT_TITLE = 'DEV-SAMPLE-PRODUCT';
const SHIPPING_TITLE = 'DEV-SAMPLE-SHIPPING';
const startsAt = new Date().toISOString();

function randomCode() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `DEV-${out}`;
}

/**
 * Existing discount with this title, as {id, code}, or null. Lists without a
 * search query: the `query:` filter runs on a search index that lags behind
 * writes by seconds, which would let a quick re-run create duplicates.
 */
async function existing(title) {
  const data = await admin(`#graphql
    {
      codeDiscountNodes(first: 100, sortKey: CREATED_AT) {
        nodes {
          id
          codeDiscount {
            ... on DiscountCodeBasic { title codes(first: 1) { nodes { code } } }
            ... on DiscountCodeFreeShipping { title codes(first: 1) { nodes { code } } }
          }
        }
      }
    }`);
  const node = data.codeDiscountNodes.nodes.find(
    (n) => n.codeDiscount?.title === title,
  );
  if (!node) return null;
  return {id: node.id, code: node.codeDiscount.codes.nodes[0]?.code};
}

async function variantIdBySku(sku) {
  const data = await admin(
    `#graphql
    query VariantBySku($query: String!) {
      productVariants(first: 2, query: $query) { nodes { id sku } }
    }`,
    {query: `sku:${sku}`},
  );
  const matches = data.productVariants.nodes.filter((v) => v.sku === sku);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one variant with sku ${sku}, found ${matches.length}`,
    );
  return matches[0].id;
}

async function ensureProduct() {
  const found = await existing(PRODUCT_TITLE);
  if (found) return found;
  const code = process.env.SAMPLE_DISCOUNT_CODE || randomCode();
  const variantId = await variantIdBySku('OPENRX-GEMINI');
  const result = await admin(
    `#graphql
    mutation CreateSampleDiscount($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: PRODUCT_TITLE,
        code,
        startsAt,
        endsAt: ENDS_AT,
        usageLimit: 1,
        appliesOncePerCustomer: true,
        context: {all: 'ALL'},
        combinesWith: {
          productDiscounts: false,
          orderDiscounts: false,
          shippingDiscounts: true,
        },
        customerGets: {
          value: {percentage: 1.0},
          items: {products: {productVariantsToAdd: [variantId]}},
        },
      },
    },
  );
  assertNoUserErrors('discountCodeBasicCreate', result.discountCodeBasicCreate);
  return {id: result.discountCodeBasicCreate.codeDiscountNode.id, code};
}

async function ensureShipping() {
  const found = await existing(SHIPPING_TITLE);
  if (found) return found;
  const code = process.env.SAMPLE_SHIP_CODE || randomCode();
  const result = await admin(
    `#graphql
    mutation CreateSampleShipping($input: DiscountCodeFreeShippingInput!) {
      discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: SHIPPING_TITLE,
        code,
        startsAt,
        endsAt: ENDS_AT,
        usageLimit: 1,
        context: {all: 'ALL'},
        combinesWith: {
          productDiscounts: true,
          orderDiscounts: false,
          shippingDiscounts: false,
        },
        destination: {all: true},
      },
    },
  );
  assertNoUserErrors(
    'discountCodeFreeShippingCreate',
    result.discountCodeFreeShippingCreate,
  );
  return {id: result.discountCodeFreeShippingCreate.codeDiscountNode.id, code};
}

for (const ensure of [ensureProduct, ensureShipping]) {
  const {code, id} = await ensure();
  console.log(`${code} ${id}`);
}
