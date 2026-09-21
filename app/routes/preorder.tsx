import type {Route} from './+types/preorder';
import {Link, useLoaderData} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {AddToCartButton} from '~/components/AddToCartButton';
import {SmoothImage} from '~/components/SmoothImage';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {fundingDaysLeftText} from '~/lib/funding';
import {applyCampaignProgress, fetchShopifyCampaignProgress} from '~/lib/shopify-campaign';
import {
  buildCampaigns,
  summarize,
  type PreorderCampaign,
  type PreorderSummary,
  type PreorderTier,
} from '~/lib/preorder-campaigns';
import {preorderUpdates} from '~/lib/preorder-updates';

/**
 * The crowdfunding page: the funding round itself, not a policy page about
 * it. Hero and summary strip, the live tracker, the explainer, the tiers a
 * buyer can actually order, the questions and the dated updates.
 *
 * Every preorder product links here, so this is still the one place the
 * refund guarantee and the one-delivery rule are stated in full.
 *
 * Same split as the production page: words in `content/copy/preorder.json`
 * (updates in `content/copy/preorder-updates.json`), section order here, and
 * numbers from the catalog. A copy edit is a JSON change.
 *
 * `rail={false}` and no entry in EDITORIAL_SERIES: the series is a reading
 * sequence about the project, and a page a buyer is sent to from a product
 * page is not a chapter of it. It is reachable from the footer, the sitemap
 * and every preorder product.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('preorder.meta_title') ?? 'Preorders',
    description: copyText('preorder.meta_description') ?? '',
  });

export async function loader({context}: Route.LoaderArgs) {
  // The catalog owns every campaign's products and variants. Paid preorder
  // quantities are read from Shopify orders and cached for 60 seconds. If
  // that read fails, the targets remain visible with zero confirmed units.
  const rawCatalog = await context.catalog.get();
  const snapshot = await fetchShopifyCampaignProgress(context.env).catch(() => ({
    unitsBySku: {},
    updatedAt: new Date().toISOString(),
  }));
  const catalog = applyCampaignProgress(rawCatalog, snapshot);
  // One clock for the whole page, read in the loader: a day count taken
  // during render would be the server's day at first paint and the
  // visitor's day at hydration.
  const campaigns = buildCampaigns(catalog, Date.now());
  return {
    campaigns,
    summary: summarize(campaigns, catalog.currency),
    updates: preorderUpdates(),
  };
}

const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;

/** Question and answer copy ids, written out so a missing pair is a
 *  visible gap in this list rather than a silently empty `<details>`. */
const FAQ: ReadonlyArray<readonly [string, string]> = [
  ['faq_q1', 'faq_a1'],
  ['faq_q2', 'faq_a2'],
  ['faq_q3', 'faq_a3'],
  ['faq_q4', 'faq_a4'],
  ['faq_q5', 'faq_a5'],
  ['faq_q6', 'faq_a6'],
  ['faq_q7', 'faq_a7'],
  ['faq_q8', 'faq_a8'],
  ['faq_q9', 'faq_a9'],
];

export default function PreorderRoute() {
  const {campaigns, summary, updates} = useLoaderData<typeof loader>();
  const skuGoals = campaigns.flatMap((campaign) =>
    campaign.tiers
      .filter((tier) => tier.targetUnits != null && tier.unitsFunded != null)
      .map((tier) => ({campaign, tier})),
  );
  const hasCampaigns = skuGoals.length > 0;

  return (
    <EditorialShell slug="preorder" rail={false} pageClassName="preorder-page">
      <header className="editorial-hero">
        <Txt id="preorder.title" as="h1" className="editorial-title" />
        <Txt id="preorder.lead" as="p" className="editorial-lead" />
        <SummaryStrip summary={summary} hasCampaigns={hasCampaigns} />
        <div className="editorial-cta">
          <a className="editorial-cta-primary" href="#tracker">
            <Txt id="preorder.cta_primary" />
          </a>
          <Link
            prefetch="viewport"
            to="/production"
            className="editorial-cta-secondary"
          >
            <Txt id="preorder.cta_secondary" />
          </Link>
        </div>
      </header>

      <section className="editorial-section" id="tracker">
        <h2 className="editorial-section-title">
          <Txt id="preorder.tracker_title" />
        </h2>
        <Txt id="preorder.tracker_lead" as="p" />
        {hasCampaigns ? (
          <ul className="preorder-tracker">
            {skuGoals.map(({campaign, tier}) => (
              <SkuTrackerRow
                key={tier.sku}
                campaign={campaign}
                tier={tier}
              />
            ))}
          </ul>
        ) : (
          <Txt id="preorder.tracker_empty" as="p" className="preorder-empty" />
        )}
      </section>

      {SECTIONS.map((s) => (
        <section className="editorial-section" key={s}>
          <Txt
            id={`preorder.${s}_title`}
            as="h2"
            className="editorial-section-title"
          />
          <Txt id={`preorder.${s}_body`} as="p" />
        </section>
      ))}

      <section className="editorial-section" id="questions">
        <h2 className="editorial-section-title">
          <Txt id="preorder.faq_title" />
        </h2>
        <div className="preorder-faq">
          {FAQ.map(([question, answer]) => (
            <details className="preorder-faq-item" key={question}>
              <summary className="preorder-faq-q">
                <Txt id={`preorder.${question}`} />
              </summary>
              <Txt id={`preorder.${answer}`} as="p" className="preorder-faq-a" />
            </details>
          ))}
        </div>
      </section>

      <section className="editorial-section" id="updates">
        <h2 className="editorial-section-title">
          <Txt id="preorder.updates_title" />
        </h2>
        <Txt id="preorder.updates_lead" as="p" />
        {updates.length > 0 ? (
          <ol className="preorder-updates">
            {updates.map((update) => (
              <li className="preorder-update" key={`${update.date}-${update.title}`}>
                <time className="preorder-update-date" dateTime={update.date}>
                  {update.date}
                </time>
                <h3 className="preorder-update-title">{update.title}</h3>
                <p className="preorder-update-body">{update.body}</p>
              </li>
            ))}
          </ol>
        ) : (
          <Txt id="preorder.updates_empty" as="p" className="preorder-empty" />
        )}
      </section>
    </EditorialShell>
  );
}

/**
 * The hero strip: the whole round in four figures. Every one of them is
 * omitted rather than guessed when the feed does not carry it, so the
 * strip can shrink to two cells without ever printing a zero it made up.
 */
function SummaryStrip({
  summary,
  hasCampaigns,
}: {
  summary: PreorderSummary;
  hasCampaigns: boolean;
}) {
  if (!hasCampaigns) {
    return <Txt id="preorder.strip_empty" as="p" className="preorder-empty" />;
  }
  const cells: Array<{key: string; label: string; value: string}> = [];
  if (summary.amountFunded > 0) {
    cells.push({
      key: 'amount',
      label: copyText('preorder.strip_amount_label') ?? 'Funded so far',
      value: formatPrice(summary.amountFunded, summary.currency),
    });
  }
  if (summary.backers != null) {
    cells.push({
      key: 'backers',
      label: copyText('preorder.strip_backers_label') ?? 'Backers',
      value: String(summary.backers),
    });
  }
  cells.push({
    key: 'products',
    label: copyText('preorder.strip_products_label') ?? 'Products funded / open',
    value: `${summary.funded} / ${summary.open}`,
  });
  if (summary.daysLeft != null) {
    cells.push({
      key: 'deadline',
      label: copyText('preorder.strip_deadline_label') ?? 'Nearest deadline',
      value: fundingDaysLeftText(summary.daysLeft),
    });
  }
  return (
    <dl className="preorder-strip">
      {cells.map((cell) => (
        <div className="preorder-strip-cell" key={cell.key}>
          <dt className="preorder-strip-label">{cell.label}</dt>
          <dd className="preorder-strip-value">{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One horizontal production goal. The SKU remains its hidden data identity. */
function SkuTrackerRow({
  campaign,
  tier,
}: {
  campaign: PreorderCampaign;
  tier: PreorderTier;
}) {
  const target = tier.targetUnits as number;
  const ordered = tier.unitsFunded as number;
  const pct = Math.min(100, Math.round((ordered / target) * 100));
  const state =
    campaign.state === 'missed'
      ? 'missed'
      : ordered >= target
        ? 'funded'
        : 'open';
  const unitsLabel = `${ordered.toLocaleString('en')} / ${target.toLocaleString('en')} ordered`;
  const image = tier.image ?? campaign.image;
  return (
    <li className="preorder-track">
      <Link
        prefetch="viewport"
        to={campaign.to}
        className="preorder-track-media"
        aria-hidden="true"
        tabIndex={-1}
      >
        {image ? (
          <SmoothImage
            alt={image.altText || `${campaign.title} ${tier.title}`}
            aspectRatio="1/1"
            data={image}
            loading="lazy"
            sizes="96px"
          />
        ) : null}
      </Link>
      <div className="preorder-track-body">
        <h3 className="preorder-track-title">
          <Link prefetch="viewport" to={campaign.to}>
            {campaign.title} <span>{tier.title}</span>
          </Link>
        </h3>
        <div className="funding-meter" data-funding-state={state}>
          <span
            className="funding-meter-track"
            role="progressbar"
            aria-label={`${campaign.title} ${tier.title} preorder goal`}
            aria-valuenow={ordered}
            aria-valuemin={0}
            aria-valuemax={target}
            aria-valuetext={unitsLabel}
          >
            <span
              className="funding-meter-fill"
              style={{width: `${pct}%`}}
            />
          </span>
          <span className="funding-meter-label">{unitsLabel}</span>
        </div>
        {tier.shipPromise ? (
          <p className="preorder-track-ship">{tier.shipPromise}</p>
        ) : null}
      </div>
      <AddToCartButton
        className="editorial-cta-primary preorder-track-cta"
        href={tier.cartAddUrl}
        product={campaign.handle}
        disabled={!tier.orderable}
        revenue={{
          currency: tier.price.currencyCode,
          amount: Number(tier.price.amount) || 0,
        }}
        ariaLabel={`${tier.ctaLabel}: ${campaign.title} ${tier.title}`}
      >
        {tier.ctaLabel}
      </AddToCartButton>
    </li>
  );
}
