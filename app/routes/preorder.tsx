import type {Route} from './+types/preorder';
import {Link, useLoaderData} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {PreorderMeter} from '~/components/PreorderMeter';
import {AddToCartButton} from '~/components/AddToCartButton';
import {Txt} from '~/components/Txt';
import {copy, copyText} from '~/lib/copy';
import {formatPrice, toCards} from '~/lib/catalog';
import {comingSoonFlag} from '~/lib/coming-soon';
import {isPurchasableStatus, resolveStatus} from '~/lib/product-content';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import type {CampaignState} from '~/lib/preorder-campaign';
import type {MoneyV2, ProductImage} from '~/lib/product-shapes';

/**
 * The campaign page: summary strip in the hero, the tracker (one card per
 * product option, each orderable from here), the explainer, the questions
 * and the dated updates.
 *
 * Words live in `content/copy/preorder.json`. The tracker reads the
 * campaign-aware catalog, so every row carries the same numbers and ship
 * promise as its product page, and a row appears only for a variant the
 * status system lets the shop sell: this page never shows a price the
 * product page hides.
 *
 * `rail={false}` and no entry in EDITORIAL_SERIES: the series is a reading
 * sequence about the project, and a page a buyer is sent to from a product
 * page is not a chapter of it.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('preorder.meta_title') ?? 'Preorders',
    description: copyText('preorder.meta_description') ?? '',
  });

type TrackerRow = {
  sku: string;
  handle: string;
  product: string;
  variant: string;
  image: ProductImage | null;
  price: MoneyV2;
  priceAfter: MoneyV2 | null;
  shipPromise: string;
  cartAddUrl: string;
  campaign: CampaignState;
};

const SECTIONS = [1, 2, 3, 4, 5, 6, 7];
const FAQ = [1, 2, 3, 4, 5, 6, 7, 8];

export async function loader({context}: Route.LoaderArgs) {
  const globalSoon = comingSoonFlag(context.env);
  const [catalog, statusFlags] = await Promise.all([
    context.catalog.get(),
    fetchStatusFlagsFast(context.env.GITHUB_STATUS_TOKEN, undefined, context.waitUntil),
  ]);

  const rows: TrackerRow[] = toCards(catalog).flatMap((card) =>
    card.variants.nodes.flatMap((v): TrackerRow[] => {
      if (!v.campaign || !v.sku || !v.shipPromise) return [];
      const status = resolveStatus(card.handle, globalSoon, statusFlags, v.availability);
      if (!isPurchasableStatus(status)) return [];
      return [
        {
          sku: v.sku,
          handle: card.handle,
          product: card.title,
          variant: v.title === 'Default Title' ? '' : v.title,
          image: v.image,
          price: v.price,
          priceAfter: v.compareAtPrice,
          shipPromise: v.shipPromise,
          cartAddUrl: v.cartAddUrl,
          campaign: v.campaign,
        },
      ];
    }),
  );

  // Only figures that say something: a zero is left out rather than shown.
  const stock = rows.filter((r) => r.campaign.paidStock);
  const funding = rows.filter((r) => !r.campaign.paidStock);
  const ordered = rows.reduce((sum, r) => sum + r.campaign.ordered, 0);
  return {
    rows,
    unavailable: catalog.campaign_counts === 'unavailable',
    summary: {
      stackLeft: stock.length
        ? stock.reduce((sum, r) => sum + r.campaign.batchUnits - r.campaign.batchOrdered, 0)
        : null,
      ordered: ordered > 0 ? ordered : null,
      // Shown once a target is reached; "0 / 8" only discourages.
      reached: funding.some((r) => r.campaign.targetReached)
        ? `${funding.filter((r) => r.campaign.targetReached).length} / ${funding.length}`
        : null,
    },
  };
}

export default function PreorderRoute() {
  const {rows, unavailable, summary} = useLoaderData<typeof loader>();
  const updates = copy('preorder.updates');
  const updateList = Array.isArray(updates) ? updates.filter((u) => u.trim()) : [];

  const cells = [
    summary.stackLeft !== null
      ? {key: 'stack', label: 'preorder.strip_stack_label', value: String(summary.stackLeft)}
      : null,
    summary.reached !== null
      ? {key: 'reached', label: 'preorder.strip_reached_label', value: summary.reached}
      : null,
    summary.ordered !== null
      ? {key: 'ordered', label: 'preorder.strip_ordered_label', value: String(summary.ordered)}
      : null,
  ].filter((c): c is {key: string; label: string; value: string} => c !== null);

  return (
    <EditorialShell slug="preorder" rail={false} pageClassName="preorder-page">
      <header className="editorial-hero">
        <Txt id="preorder.title" as="h1" className="editorial-title" />
        <Txt id="preorder.lead" as="p" className="editorial-lead" />
        {unavailable ? (
          <Txt id="preorder.strip_unavailable" as="p" className="preorder-empty" />
        ) : cells.length ? (
          <dl className="preorder-strip">
            {cells.map((cell) => (
              <div className="preorder-strip-cell" key={cell.key}>
                <Txt id={cell.label} as="dt" className="preorder-strip-label" />
                <dd className="preorder-strip-value">{cell.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="editorial-cta">
          <a className="editorial-cta-primary" href="#tracker">
            <Txt id="preorder.cta_primary" />
          </a>
          <Link prefetch="viewport" to="/production" className="editorial-cta-secondary">
            <Txt id="preorder.cta_secondary" />
          </Link>
        </div>
      </header>

      <section className="editorial-section" id="tracker">
        <Txt id="preorder.tracker_title" as="h2" className="editorial-section-title" />
        <Txt id="preorder.tracker_lead" as="p" />
        {rows.length ? (
          <ul className="preorder-tracker">
            {rows.map((row) => (
              <TrackerCard key={row.sku} row={row} />
            ))}
          </ul>
        ) : (
          <Txt id="preorder.tracker_empty" as="p" className="preorder-empty" />
        )}
      </section>

      {SECTIONS.map((n) => (
        <section key={n} className="editorial-section">
          <Txt id={`preorder.s${n}_title`} as="h2" className="editorial-section-title" />
          <Txt id={`preorder.s${n}_body`} as="p" />
        </section>
      ))}

      <section className="editorial-section" id="questions">
        <Txt id="preorder.faq_title" as="h2" className="editorial-section-title" />
        <div className="preorder-faq">
          {FAQ.map((n) => (
            <details className="preorder-faq-item" key={n}>
              <summary className="preorder-faq-q">
                <Txt id={`preorder.faq_q${n}`} />
              </summary>
              <Txt id={`preorder.faq_a${n}`} as="p" className="preorder-faq-a" />
            </details>
          ))}
        </div>
      </section>

      <section className="editorial-section" id="updates">
        <Txt id="preorder.updates_title" as="h2" className="editorial-section-title" />
        <Txt id="preorder.updates_lead" as="p" />
        {updateList.length ? (
          <ol className="preorder-updates">
            {updateList.map((entry) => (
              <li className="preorder-update" key={entry}>{entry}</li>
            ))}
          </ol>
        ) : (
          <Txt id="preorder.updates_empty" as="p" className="preorder-empty" />
        )}
      </section>
    </EditorialShell>
  );
}

function TrackerCard({row}: {row: TrackerRow}) {
  const name = row.variant ? `${row.product} ${row.variant}` : row.product;
  const cta = copyText('product-chrome.buy_cta_preorder') ?? 'Add to cart';
  return (
    <li className="preorder-track">
      <Link
        prefetch="viewport"
        to={`/products/${row.handle}`}
        className="preorder-track-media"
        aria-hidden="true"
        tabIndex={-1}
      >
        {row.image ? (
          <img src={row.image.url} alt="" loading="lazy" width={72} height={72} />
        ) : (
          <span className="preorder-track-initial">{row.product.slice(4, 5) || row.product[0]}</span>
        )}
      </Link>
      <div className="preorder-track-body">
        <div className="preorder-track-head">
          <h3 className="preorder-track-title">
            <Link prefetch="viewport" to={`/products/${row.handle}`}>
              {row.product} {row.variant ? <span>{row.variant}</span> : null}
            </Link>
          </h3>
          <span className="preorder-track-price">
            {formatPrice(row.price.amount, row.price.currencyCode)}
          </span>
        </div>
        <PreorderMeter campaign={row.campaign} priceAfter={row.priceAfter} compact />
        <p className="preorder-track-ship">{row.shipPromise}</p>
      </div>
      <AddToCartButton
        className="preorder-track-cta"
        href={row.cartAddUrl}
        product={row.handle}
        revenue={{currency: row.price.currencyCode, amount: Number(row.price.amount) || 0}}
        ariaLabel={`${cta}: ${name}`}
      >
        {cta}
      </AddToCartButton>
    </li>
  );
}
