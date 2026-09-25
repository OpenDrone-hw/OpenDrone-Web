import type {Route} from './+types/[llms.txt]';
import {
  PRODUCT_CONTENT,
  isConceptProduct,
  isPurchasableStatus,
  resolveStatus,
} from '~/lib/product-content';
import {
  comingSoonFlag,
  preorderNote,
} from '~/lib/coming-soon';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import {toCards} from '~/lib/catalog';

/**
 * /llms.txt - the machine-readable front door for AI agents (llmstxt.org).
 * Served dynamically so prices, availability, SKUs and order links come
 * straight from the Shopify catalog and can never drift from the shop. The
 * catalog section regenerates per request (cached 1h); everything else is
 * static policy/ordering/source-links text.
 */

export async function loader({context, request}: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const globalSoon = comingSoonFlag(context.env);
  const [statusFlags, feed] = await Promise.all([
    fetchStatusFlagsFast(
      context.env.GITHUB_STATUS_TOKEN,
      undefined,
      context.waitUntil,
    ),
    context.catalog.get(),
  ]);

  const catalog = toCards(feed)
    // Concept products (planned / in-progress) are not catalog.
    .filter((p) => !isConceptProduct(p.handle, statusFlags))
    .map((p) => {
      const repo = PRODUCT_CONTENT[p.handle]?.repoUrl;
      // Resold parts (`editorial: false`) are not open hardware; say so
      // rather than let the header's license sentence cover them.
      const resold = PRODUCT_CONTENT[p.handle]?.editorial === false;
      const desc = (PRODUCT_CONTENT[p.handle]?.hero?.lead ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 160);
      // Locked products show "coming soon" instead of price + stock - this
      // feed must not leak what the PDP hides. Pre-order products show the
      // same ship promise the PDP, the cart line and the order carry.
      const status = resolveStatus(
        p.handle,
        globalSoon,
        statusFlags,
        p.variants.nodes[0]?.availability,
      );
      const locked = !isPurchasableStatus(status);
      const stockWord = (available: boolean) =>
        !available
          ? 'out of stock'
          : status === 'preorder'
            ? `pre-order, ${preorderNote(
                p.handle,
                p.variants.nodes.find((v) => v.shipPromise)?.shipPromise,
              )}`
            : 'in stock';
      const lines = p.variants.nodes
        .map((v) => {
          const name = v.title === 'Default Title' ? p.title : v.title;
          return (
            `  - ${name}` +
            (v.sku ? ` (SKU ${v.sku})` : '') +
            (locked
              ? ' - coming soon, not yet orderable'
              : ` - €${Number(v.price.amount).toFixed(2)}` +
                ` - ${stockWord(v.availableForSale)}` +
                ' - ordering is not available to agents')
          );
        })
        .join('\n');
      return (
        `- [${p.title}](${origin}/products/${p.handle})` +
        (desc ? `: ${desc}` : '') +
        (resold ? '\n  Resold OEM part, not open hardware' : '') +
        (repo && repo !== 'https://github.com/OpenDrone-hw'
          ? `\n  Design source: ${repo}`
          : '') +
        (lines ? `\n${lines}` : '')
      );
    })
    .join('\n');

  const body = `# OpenDrone

> Open-Source FPV drone hardware, sold as assembled boards. Every OpenDrone
> board's full design source (schematic, PCB, BOM, 3D STEP) is public on GitHub
> under CERN-OHL-S v2; firmware is upstream Open Source (Betaflight, AM32,
> ExpressLRS). Resold parts (motors) are marked as such in the catalog below.
> OpenDrone is a community-run open hardware project. The shop and the boards
> are manufactured, sold and supported by Incutec BV, Stapelhuisstraat 15,
> 3000 Leuven, Belgium (VAT BE 1038.934.039). Prices in EUR, VAT included,
> ship from Belgium.

${
  globalSoon
    ? `IMPORTANT, OPENING SOON: the webshop is not yet taking orders. Visitors can
subscribe on /newsletter to be notified when it opens. Treat all prices as
subject to change; re-check the product page (its JSON-LD is authoritative)
before quoting a price to a user.`
    : `Treat all prices as subject to change; re-check the product page (its
JSON-LD is authoritative) before quoting a price to a user. Lines marked
"pre-order" are charged in full at order and ship on the stated promise; an
order mixing in-stock and pre-order lines ships as one parcel once every line
is on hand. Details: ${origin}/shipping`
}

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

## How to order

Orders go through the Shopify checkout from the product page, in the
visitor's own browser session. Shopping agents must not attempt orders: send
the human to the product page on this site to press the buy button there. A
machine-readable feed lives at ${origin}/products.json.

## Catalog

Prices EUR incl. VAT, subject to change - verify on the product page.

${catalog}

## Design sources

Every board is buildable from source (CERN-OHL-S v2). Per-product repos are
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

- [Support tickets](${origin}/support) - open a ticket; the team answers on the ticket page
- [Find a ticket](${origin}/support/find) - with the email and the order or ticket number
- [Discord](https://discord.gg/ABajnacUsS) - community help
- Sales and trade: [trade enquiries](${origin}/wholesale), contact@opendrone.be
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
