import type {Route} from './+types/preorder';
import {Link, useLoaderData} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {AddToCartButton} from '~/components/AddToCartButton';
import {ProductPrice} from '~/components/ProductPrice';
import {SmoothImage} from '~/components/SmoothImage';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {fundingDaysLeftText} from '~/lib/funding';
import {mergeFundingOverlay} from '~/lib/funding-overlay';
import {
  buildCampaigns,
  otherProducts,
  summarize,
  type PreorderCampaign,
  type PreorderSummary,
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
  // The catalog is cached 5 minutes and owns every campaign's existence,
  // target and deadline; the overlay refreshes the live fields every 60
  // seconds and never rejects, so an absent or empty overlay simply leaves
  // the catalog's own numbers standing and this page still renders.
  const [rawCatalog, fundingOverlay] = await Promise.all([
    context.catalog.get(),
    context.fundingOverlay.get(),
  ]);
  const catalog = mergeFundingOverlay(rawCatalog, fundingOverlay);
  // One clock for the whole page, read in the loader: a day count taken
  // during render would be the server's day at first paint and the
  // visitor's day at hydration.
  const campaigns = buildCampaigns(catalog, Date.now());
  return {
    campaigns,
    summary: summarize(campaigns, catalog.currency),
    others: otherProducts(catalog),
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
  const {campaigns, summary, others, updates} = useLoaderData<typeof loader>();
  const hasCampaigns = campaigns.length > 0;
  const tierCount = campaigns.reduce((n, c) => n + c.tiers.length, 0);

  return (
    <EditorialShell slug="preorder" rail={false} pageClassName="preorder-page">
      <header className="editorial-hero">
        <Txt id="preorder.title" as="h1" className="editorial-title" />
        <Txt id="preorder.lead" as="p" className="editorial-lead" />
        <SummaryStrip summary={summary} hasCampaigns={hasCampaigns} />
        <div className="editorial-cta">
          <a className="editorial-cta-primary" href="#tiers">
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
            {campaigns.map((campaign) => (
              <TrackerCard key={campaign.handle} campaign={campaign} />
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

      <section className="editorial-section" id="tiers">
        <h2 className="editorial-section-title">
          <Txt id="preorder.tiers_title" />
        </h2>
        <Txt id="preorder.tiers_lead" as="p" />
        {tierCount > 0 ? (
          campaigns.map((campaign) => (
            <div className="preorder-tier-group" key={campaign.handle}>
              <h3 className="preorder-tier-group-title">{campaign.title}</h3>
              <ul className="preorder-tiers">
                {campaign.tiers.map((tier) => (
                  <li className="preorder-tier" key={tier.sku || tier.title}>
                    <h4 className="preorder-tier-title">{tier.title}</h4>
                    <ProductPrice
                      price={tier.price}
                      compareAtPrice={tier.compareAtPrice}
                      discountLabel={tier.discountLabel}
                    />
                    {tier.unitsLeft != null ? (
                      <p className="preorder-tier-left">
                        {tier.unitsLeft} left at this price
                      </p>
                    ) : null}
                    {tier.shipPromise ? (
                      <p className="preorder-tier-ship">{tier.shipPromise}</p>
                    ) : null}
                    <AddToCartButton
                      className="editorial-cta-primary preorder-tier-cta"
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
                ))}
              </ul>
            </div>
          ))
        ) : (
          <Txt id="preorder.tiers_empty" as="p" className="preorder-empty" />
        )}
      </section>

      {others.length > 0 ? (
        <section className="editorial-section">
          <h2 className="editorial-section-title">
            <Txt id="preorder.others_title" />
          </h2>
          <Txt id="preorder.others_lead" as="p" />
          <ul className="editorial-list preorder-others">
            {others.map((product) => (
              <li key={product.handle}>
                <Link prefetch="viewport" to={product.to}>
                  {product.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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

/**
 * One campaign in the tracker. The bar shares the `.funding-meter`
 * geometry and state colours with the product surfaces, so a campaign
 * looks the same wherever it is read; `aria-valuetext` carries the exact
 * "X of Y units" the label under it prints, which is why neither can
 * contradict the other.
 */
function TrackerCard({campaign}: {campaign: PreorderCampaign}) {
  const countdown =
    campaign.state === 'open'
      ? fundingDaysLeftText(campaign.daysLeft)
      : campaign.statusText;
  return (
    <li className="preorder-track">
      <Link
        prefetch="viewport"
        to={campaign.to}
        className="preorder-track-media"
        aria-hidden="true"
        tabIndex={-1}
      >
        {campaign.image ? (
          <SmoothImage
            alt={campaign.image.altText || campaign.title}
            aspectRatio="1/1"
            data={campaign.image}
            loading="lazy"
            sizes="(min-width: 45em) 200px, 40vw"
          />
        ) : null}
      </Link>
      <div className="preorder-track-body">
        <h3 className="preorder-track-title">
          <Link prefetch="viewport" to={campaign.to}>
            {campaign.title}
          </Link>
        </h3>
        <div className="funding-meter" data-funding-state={campaign.state}>
          <span
            className="funding-meter-track"
            role="progressbar"
            aria-label={`${campaign.title} funding progress`}
            aria-valuenow={campaign.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={campaign.unitsLabel}
          >
            <span
              className="funding-meter-fill"
              style={{width: `${campaign.pct}%`}}
            />
          </span>
          <span className="funding-meter-label">{campaign.unitsLabel}</span>
        </div>
        <dl className="preorder-track-stats">
          {campaign.amountFunded != null ? (
            <div className="preorder-track-stat">
              {/* "Raised", not "Funded": the state chip beside it already
                  uses "Funded"/"Funding missed" for the campaign state, and
                  two different meanings of one word read as a defect. */}
              <dt>Raised</dt>
              <dd>{formatPrice(campaign.amountFunded, campaign.currency)}</dd>
            </div>
          ) : null}
          {campaign.backers != null ? (
            <div className="preorder-track-stat">
              <dt>Backers</dt>
              <dd>{campaign.backers}</dd>
            </div>
          ) : null}
          {countdown ? (
            <div className="preorder-track-stat">
              <dt>{campaign.state === 'open' ? 'Time' : 'State'}</dt>
              <dd>
                <span
                  className="preorder-chip"
                  data-funding-state={campaign.state}
                >
                  {countdown}
                </span>
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </li>
  );
}
