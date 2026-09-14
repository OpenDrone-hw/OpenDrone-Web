#!/usr/bin/env node
/**
 * Ensure every product handle and Model variant in stock/product_skus.json
 * exists in Shopify. Creates missing products (productSet) and missing
 * variants (productVariantsBulkCreate). Never edits existing variants:
 * prices and titles are owned by the shop admin, SKUs by sync-product-skus.
 *
 *   node scripts/shopify-infra/ensure-products.mjs            preview
 *   node scripts/shopify-infra/ensure-products.mjs --apply    write
 *   --catalog <path>   read another catalogue file (default: stock repo)
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {admin, assertNoUserErrors} from './_client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const catalogArg = args.indexOf('--catalog');
const catalogPath =
  catalogArg >= 0 && args[catalogArg + 1]
    ? path.resolve(args[catalogArg + 1])
    : path.resolve(here, '../../../../stock/product_skus.json');

const OPTION = 'Model';
const VENDOR = 'OpenDrone';

/** Per-handle facts that the catalogue does not carry. Used only on create. */
const PRODUCT_DEFAULTS = {
  openesc: {productType: 'ESC'},
  'openfc-lite': {productType: 'Flight Controller'},
  openrx: {productType: 'Receiver'},
  openframe: {productType: 'Frame'},
  openmotor: {productType: 'Motor', weightKg: 0.05},
};

const products = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).products;

const byHandle = new Map();
for (const product of products) {
  const {handle, model} = product.shopify ?? {};
  if (!handle || !model)
    throw new Error(`${product.sku}: missing Shopify mapping`);
  const price = product.commercial?.beta_price_eur_vat_included;
  const entries = byHandle.get(handle) ?? [];
  entries.push({model, sku: product.sku, name: product.name, price});
  byHandle.set(handle, entries);
}

/** "OpenMotor 1604" + "OpenMotor 2207" with the models stripped -> "OpenMotor". */
function titleFor(entries) {
  const stripped = entries.map(({name, model}) => {
    const forms = [model, model.replace(/×/g, 'x'), model.replace(/x/g, '×')];
    let out = name;
    for (const form of forms) out = out.split(form).join('');
    return out.trim().split(/\s+/);
  });
  const words = [];
  for (let i = 0; ; i++) {
    const word = stripped[0][i];
    if (word === undefined || stripped.some((w) => w[i] !== word)) break;
    words.push(word);
  }
  const title = words.join(' ');
  if (!title)
    throw new Error(
      `cannot derive a title from ${entries.map((e) => e.name).join(', ')}`,
    );
  return title;
}

function money(price, sku) {
  if (typeof price !== 'number')
    throw new Error(`${sku}: beta_price_eur_vat_included missing`);
  return price.toFixed(2);
}

function inventoryItem(sku, defaults) {
  const item = {sku, tracked: true, requiresShipping: true};
  if (defaults.weightKg !== undefined) {
    item.measurement = {weight: {value: defaults.weightKg, unit: 'KILOGRAMS'}};
  }
  return item;
}

const mode = apply ? 'APPLY' : 'PREVIEW';
let changes = 0;

for (const [handle, expected] of byHandle) {
  const data = await admin(
    `#graphql
    query ProductState($query: String!) {
      products(first: 1, query: $query) {
        nodes {
          id
          title
          options { name }
          variants(first: 100) {
            nodes { id sku selectedOptions { name value } }
          }
        }
      }
    }`,
    {query: `handle:${handle}`},
  );
  const product = data.products.nodes[0];
  const defaults = PRODUCT_DEFAULTS[handle];

  if (!product) {
    if (!defaults)
      throw new Error(
        `${handle}: add productType to PRODUCT_DEFAULTS before creating`,
      );
    const title = titleFor(expected);
    changes++;
    console.log(
      `${mode}: ${handle}: create product "${title}" (${defaults.productType}) with ${OPTION} ` +
        expected
          .map((e) => `${e.model} [${e.sku} ${money(e.price, e.sku)}]`)
          .join(', '),
    );
    if (!apply) continue;
    const result = await admin(
      `#graphql
      mutation CreateProduct($input: ProductSetInput!) {
        productSet(input: $input, synchronous: true) {
          product {
            id
            variants(first: 100) { nodes { id sku selectedOptions { name value } } }
          }
          userErrors { field message }
        }
      }`,
      {
        input: {
          handle,
          title,
          vendor: VENDOR,
          productType: defaults.productType,
          status: 'ACTIVE',
          productOptions: [
            {name: OPTION, values: expected.map((e) => ({name: e.model}))},
          ],
          variants: expected.map((e) => ({
            optionValues: [{optionName: OPTION, name: e.model}],
            sku: e.sku,
            price: money(e.price, e.sku),
            inventoryItem: inventoryItem(e.sku, defaults),
          })),
        },
      },
    );
    assertNoUserErrors('productSet', result.productSet);
    const created = result.productSet.product;
    console.log(`  product ${created.id}`);
    for (const v of created.variants.nodes) {
      console.log(
        `  variant ${v.id} ${OPTION}=${v.selectedOptions[0]?.value} sku=${v.sku}`,
      );
    }
    continue;
  }

  if (!product.options.some((o) => o.name === OPTION)) {
    throw new Error(
      `${handle}: product has no "${OPTION}" option; fix it in Shopify admin first`,
    );
  }
  const existing = new Map(
    product.variants.nodes.map((variant) => [
      variant.selectedOptions.find((o) => o.name === OPTION)?.value,
      variant,
    ]),
  );
  const missing = expected.filter((e) => !existing.has(e.model));
  for (const e of expected) {
    const variant = existing.get(e.model);
    if (!variant) continue;
    const skuNote =
      variant.sku === e.sku
        ? ''
        : ` (sku=${variant.sku ?? 'none'}, run sync-product-skus)`;
    console.log(`OK: ${handle} ${e.model} exists ${variant.id}${skuNote}`);
  }
  if (!missing.length) continue;

  changes += missing.length;
  for (const e of missing) {
    console.log(
      `${mode}: ${handle}: add ${OPTION}=${e.model} [${e.sku} ${money(e.price, e.sku)}]`,
    );
  }
  if (!apply) continue;
  const result = await admin(
    `#graphql
    mutation AddVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id sku selectedOptions { name value } }
        userErrors { field message }
      }
    }`,
    {
      productId: product.id,
      variants: missing.map((e) => ({
        optionValues: [{optionName: OPTION, name: e.model}],
        price: money(e.price, e.sku),
        inventoryItem: inventoryItem(e.sku, defaults ?? {}),
      })),
    },
  );
  assertNoUserErrors(
    'productVariantsBulkCreate',
    result.productVariantsBulkCreate,
  );
  for (const v of result.productVariantsBulkCreate.productVariants) {
    console.log(
      `  variant ${v.id} ${OPTION}=${v.selectedOptions[0]?.value} sku=${v.sku}`,
    );
  }
}

if (changes === 0) {
  console.log(
    'OK: every catalogue product and Model variant exists in Shopify.',
  );
} else if (apply) {
  console.log(`OK: applied ${changes} change${changes === 1 ? '' : 's'}.`);
} else {
  console.log(
    `PREVIEW: ${changes} change${changes === 1 ? '' : 's'}; rerun with --apply to write.`,
  );
}
