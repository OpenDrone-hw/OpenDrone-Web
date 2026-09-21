import type {Route} from './+types/preorder';
import {Link, useLoaderData} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {PreorderMeter} from '~/components/PreorderMeter';
import {Txt} from '~/components/Txt';
import {copy, copyText} from '~/lib/copy';
import {formatPrice, toCards} from '~/lib/catalog';
import {comingSoonFlag} from '~/lib/coming-soon';
import {isPurchasableStatus, resolveStatus} from '~/lib/product-content';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import type {CampaignState} from '~/lib/preorder-campaign';
import type {MoneyV2} from '~/lib/product-shapes';

/**
 * The preorder explainer and campaign tracker. Words live in
 * `content/copy/preorder.json`; the tracker reads the campaign-aware catalog,
 * so every row carries the same numbers and ship promise as its product
 * page. A row appears only for a variant the status system lets the shop
 * sell, so this page never shows a price the product page hides.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('preorder.meta_title') ?? 'Preorders',
    description: copyText('preorder.meta_description') ?? '',
  });

type TrackerRow = {
  sku: string;
  title: string;
  price: MoneyV2;
  priceAfter: MoneyV2 | null;
  shipPromise: string;
  campaign: CampaignState;
};

type TrackerProduct = {handle: string; title: string; rows: TrackerRow[]};

const FAQ = [1, 2, 3, 4, 5, 6, 7, 8];
const SECTIONS = [1, 2, 3, 4, 5, 6, 7];

export async function loader({context}: Route.LoaderArgs) {
  const globalSoon = comingSoonFlag(context.env);
  const [catalog, statusFlags] = await Promise.all([
    context.catalog.get(),
    fetchStatusFlagsFast(context.env.GITHUB_STATUS_TOKEN, undefined, context.waitUntil),
  ]);

  const products: TrackerProduct[] = toCards(catalog)
    .map((card) => {
      const rows = card.variants.nodes.flatMap((v): TrackerRow[] => {
        if (!v.campaign || !v.sku || !v.shipPromise) return [];
        const status = resolveStatus(card.handle, globalSoon, statusFlags, v.availability);
        if (!isPurchasableStatus(status)) return [];
        return [
          {
            sku: v.sku,
            title: v.title === 'Default Title' ? card.title : v.title,
            price: v.price,
            priceAfter: v.compareAtPrice,
            shipPromise: v.shipPromise,
            campaign: v.campaign,
          },
        ];
      });
      return {handle: card.handle, title: card.title, rows};
    })
    .filter((p) => p.rows.length > 0);

  const rows = products.flatMap((p) => p.rows);
  const stackLeft = rows
    .filter((r) => r.campaign.paidStock)
    .reduce((sum, r) => sum + (r.campaign.batchUnits - r.campaign.batchOrdered), 0);

  return {
    products,
    unavailable: catalog.campaign_counts === 'unavailable',
    summary: {
      ordered: rows.reduce((sum, r) => sum + r.campaign.ordered, 0),
      reached: rows.filter((r) => r.campaign.targetReached).length,
      targets: rows.filter((r) => r.campaign.target !== null).length,
      stackLeft: rows.some((r) => r.campaign.paidStock) ? stackLeft : null,
    },
  };
}

export default function PreorderRoute() {
  const {products, unavailable, summary} = useLoaderData<typeof loader>();
  const updates = copy('preorder.updates');
  const updateList = Array.isArray(updates) ? updates.filter((u) => u.trim()) : [];

  return (
    <EditorialShell slug="preorder" rail={false}>
      <header className="editorial-hero">
        <Txt id="preorder.title" as="h1" className="editorial-title" />
        <Txt id="preorder.lead" as="p" className="editorial-lead" />
      </header>

      {products.length || unavailable ? (
      <section className="preorder-strip" aria-label={copyText('preorder.tracker_title') ?? 'Campaign'}>
        {unavailable ? (
          <Txt id="preorder.strip_unavailable" as="p" className="preorder-strip-note" />
        ) : (
          <dl>
            <div>
              <Txt id="preorder.strip_ordered_label" as="dt" />
              <dd>{summary.ordered}</dd>
            </div>
            <div>
              <Txt id="preorder.strip_reached_label" as="dt" />
              <dd>
                {summary.reached} / {summary.targets}
              </dd>
            </div>
            {summary.stackLeft !== null ? (
              <div>
                <Txt id="preorder.strip_stack_label" as="dt" />
                <dd>{summary.stackLeft}</dd>
              </div>
            ) : null}
          </dl>
        )}
      </section>
      ) : null}

      <section className="editorial-section" id="targets">
        <Txt id="preorder.tracker_title" as="h2" className="editorial-section-title" />
        <Txt id="preorder.tracker_lead" as="p" />
        {products.length === 0 ? (
          <Txt id="preorder.tracker_empty" as="p" className="preorder-tracker-empty" />
        ) : (
          <div className="preorder-tracker">
            {products.map((product) => (
              <article key={product.handle} className="preorder-tracker-product">
                <h3>
                  <Link prefetch="intent" to={`/products/${product.handle}`}>
                    {product.title}
                  </Link>
                </h3>
                {product.rows.map((row) => (
                  <div key={row.sku} className="preorder-tracker-row">
                    <div className="preorder-tracker-head">
                      <span className="preorder-tracker-name">{row.title}</span>
                      <span className="preorder-tracker-price">
                        {formatPrice(row.price.amount, row.price.currencyCode)}
                      </span>
                    </div>
                    <PreorderMeter campaign={row.campaign} priceAfter={row.priceAfter} compact />
                    <p className="preorder-tracker-ships">{row.shipPromise}</p>
                  </div>
                ))}
              </article>
            ))}
          </div>
        )}
      </section>

      {SECTIONS.map((n) => (
        <section key={n} className="editorial-section">
          <Txt id={`preorder.s${n}_title`} as="h2" className="editorial-section-title" />
          <Txt id={`preorder.s${n}_body`} as="p" />
        </section>
      ))}

      <section className="editorial-section">
        <Txt id="preorder.faq_title" as="h2" className="editorial-section-title" />
        <dl className="preorder-faq">
          {FAQ.map((n) => (
            <div key={n}>
              <Txt id={`preorder.faq_q${n}`} as="dt" />
              <Txt id={`preorder.faq_a${n}`} as="dd" />
            </div>
          ))}
        </dl>
      </section>

      <section className="editorial-section">
        <Txt id="preorder.updates_title" as="h2" className="editorial-section-title" />
        <Txt id="preorder.updates_lead" as="p" />
        {updateList.length ? (
          <ul className="preorder-updates">
            {updateList.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        ) : (
          <Txt id="preorder.updates_empty" as="p" />
        )}
      </section>

      <section className="editorial-cta">
        <a href="#targets" className="editorial-cta-primary">
          <Txt id="preorder.cta_primary" />
        </a>
        <Link prefetch="viewport" to="/production" className="editorial-cta-secondary">
          <Txt id="preorder.cta_secondary" />
        </Link>
      </section>
    </EditorialShell>
  );
}
