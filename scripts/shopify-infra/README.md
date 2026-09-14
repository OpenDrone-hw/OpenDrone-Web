# Shopify infra scripts

Admin API scripts for the store. All read `PUBLIC_STORE_DOMAIN` and
`SHOPIFY_ADMIN_API_TOKEN` from the repo `.env` through `_client.mjs` and run
with `node scripts/shopify-infra/<script>`. Writers preview by default and
need `--apply`; every script is safe to re-run.

| Script                    | Purpose                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `_client.mjs`             | shared Admin GraphQL client and `userErrors` guard                                                        |
| `_inspect-catalog.mjs`    | list every product with status, type, collections and tags                                                |
| `_inspect-state.mjs`      | dump options, variants, SKUs and prices of the board products                                             |
| `_inspect-storefront.mjs` | list products as the Storefront API sees them                                                             |
| `ensure-products.mjs`     | create products and Model variants missing from `stock/product_skus.json` (`--apply`, `--catalog <path>`) |
| `sync-product-skus.mjs`   | align variant SKUs with `stock/product_skus.json` (`--apply`, `--catalog <path>`)                         |
| `snapshot-store.mjs`      | write `docs/store-snapshot.json`, the committed store configuration record                                |
| `dev-sample-discount.mjs` | create the two sample discounts for the end-to-end order test; codes are random and printed once          |
