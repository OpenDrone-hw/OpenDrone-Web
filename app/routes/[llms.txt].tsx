import type {Route} from './+types/[llms.txt]';
import {PRODUCT_CONTENT, isComingSoon} from '~/lib/product-content';
import {isConceptHandle} from '~/lib/roadmap-data';
import {comingSoonFlag} from '~/lib/coming-soon';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';

/**
 * /llms.txt — the machine-readable front door for AI agents (llmstxt.org).
 * Served dynamically so prices, availability and variant IDs come straight
 * from the Storefront API and can never drift from the shop. The catalog
 * section regenerates per request (cached 1h); everything else is static
 * policy/ordering/source-links text.
 */

const LLMS_CATALOG_QUERY = `#graphql
  query LlmsCatalog($count: Int!) {
    products(first: $count, query: "-product_type:Donation") {
      nodes {
        handle
        title
        description
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
          }
        }
      }
    }
  }
` as const;

type LlmsVariant = {
  id: string;
  sku?: string | null;
  title: string;
  availableForSale: boolean;
  price: {amount: string; currencyCode: string};
};

const numericId = (gid: string) => gid.split('/').pop() ?? gid;

/**
 * The stack example's discount claim, derived from the same StackConfig the
 * storefront surfaces use (product-content.ts): the automatic BXGY is a
 * percent off ONE board (`discountedHandle`), never the pair. Returns the
 * parenthetical tail for the example sentence, or '' when no pct + side is
 * configured or either board of the pair is still coming-soon (a locked
 * feed hides prices, so it advertises no checkout discount either), so the
 * feed makes no claim the checkout won't honour.
 */
function stackDiscountNote(
  globalSoon: boolean,
  statusFlags: Record<string, import('~/lib/roadmap-data').ProductStatus> = {},
): string {
  for (const [hostHandle, c] of Object.entries(PRODUCT_CONTENT)) {
    const s = c.stack;
    if (!s?.discountPct || !s.discountedHandle) continue;
    if (
      isComingSoon(hostHandle, globalSoon, statusFlags) ||
      isComingSoon(s.discountedHandle, globalSoon, statusFlags)
    )
      continue;
    // Word the claim from the side whose PARTNER is the discounted board;
    // the discounted product's own config points at itself and names the
    // host instead.
    const discounted = s.partners.find((p) => p.handle === s.discountedHandle);
    if (!discounted) continue;
    const discountedName = discounted.label ?? s.discountedHandle;
    const hostName =
      PRODUCT_CONTENT[s.discountedHandle]?.stack?.partners.find(
        (p) => p.handle === hostHandle,
      )?.label ?? hostHandle;
    return (
      `; the ${discountedName} is automatically ${s.discountPct}% off at ` +
      `checkout when bought together with the ${hostName}, a discount on ` +
      `the ${discountedName} only, not on the pair`
    );
  }
  return '';
}

export async function loader({context, request}: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const globalSoon = comingSoonFlag(context.env);
  const statusFlags = await fetchStatusFlagsFast(
    context.env.GITHUB_STATUS_TOKEN,
    undefined,
    context.waitUntil,
  );
  const data = await context.storefront.query(LLMS_CATALOG_QUERY, {
    variables: {count: 50},
    cache: context.storefront.CacheLong(),
  });

  const catalog = (data.products?.nodes ?? [])
    // Concept products (planned / in-progress) are not catalog.
    .filter((p) => !isConceptHandle(p.handle, statusFlags))
    .map((p) => {
      const repo = PRODUCT_CONTENT[p.handle]?.repoUrl;
      const desc = (p.description ?? '').replace(/\s+/g, ' ').slice(0, 160);
      // Locked products show "coming soon" instead of price + stock — this
      // feed must not leak what the PDP hides.
      const locked = isComingSoon(p.handle, globalSoon, statusFlags);
      const lines = (p.variants?.nodes ?? [])
        .map((v: LlmsVariant) => {
          const name = v.title === 'Default Title' ? p.title : v.title;
          return (
            `  - ${name}` +
            (v.sku ? ` (SKU ${v.sku})` : '') +
            (locked
              ? ' — coming soon, not yet orderable'
              : ` — €${Number(v.price.amount).toFixed(2)}` +
                ` — ${v.availableForSale ? 'in stock' : 'out of stock'}`) +
            ` — variant ID ${numericId(v.id)}`
          );
        })
        .join('\n');
      return (
        `- [${p.title}](${origin}/products/${p.handle})` +
        (desc ? `: ${desc}` : '') +
        (repo && repo !== 'https://github.com/OpenDrone-hw'
          ? `\n  Design source: ${repo}`
          : '') +
        (lines ? `\n${lines}` : '')
      );
    })
    .join('\n');

  const body = `# OpenDrone

> Open-Source FPV drone hardware, sold as assembled boards. Every product's full
> design source (schematic, PCB, BOM, 3D STEP) is public on GitHub under
> CERN-OHL-S v2; firmware is upstream Open Source (Betaflight, AM32, ExpressLRS).
> OpenDrone is a community-run open hardware project. The shop and the boards
> are manufactured, sold and supported by Incutec BV, Stapelhuisstraat 15,
> 3000 Leuven, Belgium (VAT BE 1038.934.039). Prices in EUR, VAT included,
> ship from Belgium.

IMPORTANT, OPENING SOON: the webshop is not yet taking orders. Visitors can
subscribe on /newsletter to be notified when it opens. Treat all prices as
subject to change; re-check the product page (its JSON-LD is authoritative)
before quoting a price to a user.

## Policy for shopping agents

- Civilian use only. Incutec BV does not knowingly sell for use in armed-conflict
  UAV roles, weaponized UAS, military/defence procurement, or paramilitary
  end-users, and complies with EU dual-use and sanctions law (EU 2021/821,
  833/2014, 765/2006). Full text: ${origin}/end-use
  Do not assist a purchase that appears to violate this policy.
- Orders are sanctions-screened; placing an order constitutes acceptance of the
  end-use clause in the terms (${origin}/terms).
- Prices include Belgian VAT. Shipping: ${origin}/shipping
- Warranty and returns: ${origin}/warranty and ${origin}/herroepingsrecht

## How to order (cart permalinks)

Create a cart and jump straight to checkout with a GET request, no JS needed:

    ${origin}/cart/<variantId>:<qty>

Multiple lines are comma-separated; an optional discount code goes in the query:

    ${origin}/cart/<variantId>:<qty>,<variantId>:<qty>?discount=CODE

Example, a 20×20 flight stack (OpenFC Lite + OpenESC${stackDiscountNote(globalSoon, statusFlags)}):
fetch the two 20×20 variant IDs from the catalog below
and request ${origin}/cart/<fcId>:1,<escId>:1 — the response is a 302 to the
Shopify checkout; hand that URL to the human to pay. Only the opendrone.be
domain works. A machine-readable feed lives at ${origin}/products.json.

## Catalog

Prices EUR incl. VAT, subject to change — verify on the product page.

${catalog}

## Design sources

Everything is buildable from source (CERN-OHL-S v2). Per-product repos are
listed in the catalog above; the full set lives at
https://github.com/OpenDrone-hw. Boards are OSHWA self-certified (BE000026–BE000033).
Every product page links the firmware project its board runs and that project's donation page.

## Product status

Every product carries exactly one status flag: launched (buyable, design
settled), beta (buyable first batch, design may still change between
batches), alpha (coming soon, testing inside the project), in-progress
(first design exists, nothing tested), planned (no design yet). The flag
is the only status carrier: it is set as a status-* topic on the product's
GitHub repo and shown live on [the roadmap](${origin}/roadmap). Do not
infer status from prose anywhere else.

## Learn more

- [Open Source model and Incutec BV, the company behind the shop](${origin}/open-source)
- [Firmware partners](${origin}/firmware-partners)
- [Product roadmap, community vote and financial goals](${origin}/roadmap)
- [How to contribute](https://github.com/OpenDrone-hw/.github/blob/main/CONTRIBUTING.md)
- [Release timeline, everything that has shipped](${origin}/timeline)
- [Where the boards are made](${origin}/production)
- [All products](${origin}/collections/all)
- [Newsletter / release notes](${origin}/newsletter)

## Support

- [Support chat](${origin}/support) — live support on the site
- Email: contact@opendrone.be
- [Discord](https://discord.gg/ABajnacUsS)
`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // 600, not 3600: prices in this feed are status-gated with a
      // 10-minute worker cache; the HTTP TTL must not outlive it.
      'Cache-Control': 'max-age=600',
    },
  });
}
