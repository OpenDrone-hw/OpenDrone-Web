import type {Route} from './+types/[products.json]';
import {
  PRODUCT_CONTENT,
  isConceptProduct,
  isPurchasableStatus,
  resolveStatus,
} from '~/lib/product-content';
import {
  comingSoonFlag,
  preorderNote,
  preordersOpenFlag,
} from '~/lib/coming-soon';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';

/**
 * /products.json — machine-readable catalog feed for agents and tooling.
 * Replaces the Liquid endpoint agents probe for on Shopify stores (Hydrogen
 * doesn't ship one). Adds what no stock feed has: a ready-made cart
 * permalink per variant, the CERN-OHL-S license, and the design-source repo.
 */

const FEED_QUERY = `#graphql
  query ProductsFeed($count: Int!) {
    products(first: $count, query: "-product_type:Donation") {
      nodes {
        id
        handle
        title
        description
        productType
        featuredImage {
          url
          altText
        }
        variants(first: 12) {
          nodes {
            id
            sku
            title
            availableForSale
            price {
              amount
              currencyCode
            }
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
` as const;

const numericId = (gid: string) => gid.split('/').pop() ?? gid;

export async function loader({context, request}: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const globalSoon = comingSoonFlag(context.env);
  const preordersOpen = preordersOpenFlag(context.env);
  const statusFlags = await fetchStatusFlagsFast(
    context.env.GITHUB_STATUS_TOKEN,
    undefined,
    context.waitUntil,
  );
  const data = await context.storefront.query(FEED_QUERY, {
    variables: {count: 50},
    cache: context.storefront.CacheLong(),
  });

  const products = (data.products?.nodes ?? [])
    // Concept products (planned / in-progress) are not catalog.
    .filter((p) => !isConceptProduct(p.handle, statusFlags))
    .map((p) => {
      const content = PRODUCT_CONTENT[p.handle];
      // Locked products expose no price and no cart permalink — this feed is
      // the most scrapeable surface, so it must match what the PDP shows.
      const status = resolveStatus(
        p.handle,
        globalSoon,
        statusFlags,
        preordersOpen,
      );
      const locked = !isPurchasableStatus(status);
      return {
        handle: p.handle,
        title: p.title,
        description: p.description,
        product_type: p.productType || null,
        url: `${origin}/products/${p.handle}`,
        image: p.featuredImage?.url ?? null,
        // Resold parts (`editorial: false`) have a content file for their
        // status and copy but are not open hardware: no license claim.
        license:
          content && content.editorial !== false ? 'CERN-OHL-S-2.0' : null,
        design_source:
          content?.repoUrl &&
          content.repoUrl !== 'https://github.com/OpenDrone-hw'
            ? content.repoUrl
            : null,
        ...(locked ? {coming_soon: true} : null),
        // Pre-order: charged in full now, ships on this promise (the same
        // string the PDP, the cart line and the order attribute carry).
        ...(status === 'preorder' ? {preorder: preorderNote(p.handle)} : null),
        variants: (p.variants?.nodes ?? []).map((v) => {
          const id = numericId(v.id);
          return {
            id,
            sku: v.sku || null,
            title: v.title,
            options: Object.fromEntries(
              (v.selectedOptions ?? []).map((o) => [o.name, o.value]),
            ),
            available: locked ? false : v.availableForSale,
            price: locked ? null : v.price.amount,
            currency: locked ? null : v.price.currencyCode,
            ...(locked ? null : {cart_permalink: `${origin}/cart/${id}:1`}),
          };
        }),
      };
    });

  return new Response(
    JSON.stringify(
      {
        note: 'Availability and pricing reflect the current store response. Civilian use only — see /end-use. Agent guide: /llms.txt',
        products,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // While the coming-soon flag is ON, keep the feed on a short leash
        // (5 min) so flipping PUBLIC_COMING_SOON on launch day doesn't leave
        // agents reading a stale "coming soon" catalog for a full hour.
        // Unlocked shop → the catalog is stable, cache the full hour.
        // 600, not 3600: roadmap topics gate SALES with a 10-minute worker
        // cache, and a response cached longer than that would keep serving a
        // price after a topic downgrade (see docs/product-status.md).
        'Cache-Control': globalSoon ? 'max-age=300' : 'max-age=600',
      },
    },
  );
}
