import type {Route} from './+types/[products.json]';
import {
  PRODUCT_CONTENT,
  isConceptProduct,
  isPurchasableStatus,
  resolveStatus,
} from '~/lib/product-content';
import {comingSoonFlag, preorderNote} from '~/lib/coming-soon';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import {toCards} from '~/lib/catalog';
import {shipCountryForRequest} from '~/lib/shipping-rates';

/**
 * /products.json - machine-readable catalog feed for agents and tooling.
 * Adds what no stock feed has: the buy hand-off per variant (the same
 * `/api/shopify/cart` form the buy buttons POST, action URL plus its
 * form fields as the query string, with `cart_add_method: "POST"`), the
 * CERN-OHL-S license, and the design-source repo.
 */

export async function loader({context, request}: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const country = shipCountryForRequest(request);
  const forCountry = (href: string) => {
    const url = new URL(href, origin);
    if (country) url.searchParams.set('country', country);
    return url.toString();
  };
  const globalSoon = comingSoonFlag(context.env);
  const [statusFlags, catalog] = await Promise.all([
    fetchStatusFlagsFast(
      context.env.GITHUB_STATUS_TOKEN,
      undefined,
      context.waitUntil,
    ),
    context.catalog.forBuyer(),
  ]);

  const products = toCards(catalog)
    // Concept products (planned / in-progress) are not catalog.
    .filter((p) => !isConceptProduct(p.handle, statusFlags))
    .map((p) => {
      const content = PRODUCT_CONTENT[p.handle];
      // Locked products expose no price and no cart permalink - this feed is
      // the most scrapeable surface, so it must match what the PDP shows.
      const status = resolveStatus(
        p.handle,
        globalSoon,
        statusFlags,
        p.variants.nodes[0]?.availability,
      );
      const locked = !isPurchasableStatus(status);
      return {
        handle: p.handle,
        title: p.title,
        description: PRODUCT_CONTENT[p.handle]?.hero?.lead || null,
        product_type: p.productType || null,
        url: forCountry(`/products/${p.handle}`),
        image: p.featuredImage?.url
          ? new URL(p.featuredImage.url, origin).toString()
          : null,
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
        ...(status === 'preorder'
          ? {
              preorder: preorderNote(
                p.handle,
                p.variants.nodes.find((v) => v.shipPromise)?.shipPromise,
              ),
            }
          : null),
        variants: p.variants.nodes.map((v) => ({
          sku: v.sku,
          title: v.title,
          options: Object.fromEntries(
            v.selectedOptions.map((o) => [o.name, o.value]),
          ),
          available: locked ? false : v.availableForSale,
          price: locked ? null : v.price.amount,
          currency: locked ? null : v.price.currencyCode,
          // The hand-off: POST the query string of cart_add_url as form
          // fields to its path; the cart action refuses GET.
          ...(locked ? null : {cart_add_url: forCountry(v.cartAddUrl), cart_add_method: 'POST'}),
        })),
      };
    });

  return new Response(
    JSON.stringify(
      {
        note: 'Availability and pricing reflect the current shop response. Civilian use only - see /end-use. Agent guide: /llms.txt',
        products,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // The country can come from a cookie or the visitor's IP. A shared
        // response must never show another buyer's currency or batch.
        'Cache-Control': 'private, no-store',
      },
    },
  );
}
