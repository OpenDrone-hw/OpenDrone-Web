import type {Route} from './+types/preorder';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link, useLoaderData} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {PreorderMeter} from '~/components/PreorderMeter';
import {AddToCartButton} from '~/components/AddToCartButton';
import {TeamStrip} from '~/components/TeamStrip';
import {Txt} from '~/components/Txt';
import {copy, copyText} from '~/lib/copy';
import {formatPrice, toCards} from '~/lib/catalog';
import {comingSoonFlag} from '~/lib/coming-soon';
import {isPurchasableStatus, resolveStatus} from '~/lib/product-content';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import {CAMPAIGN} from '~/lib/catalog-client';
import {
  priceLadder,
  type CampaignState,
  type LadderStep,
  type PriceTier,
} from '~/lib/preorder-campaign';
import type {MoneyV2, ProductImage, SelectedOption} from '~/lib/product-shapes';

/**
 * The campaign page: summary strip in the hero, the model in four steps,
 * the tracker (one card per product option with its price ladder, each
 * orderable from here), the explainer, the questions and the dated updates.
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
  /** Product page link that opens this exact variant. */
  url: string;
  product: string;
  variant: string;
  image: ProductImage | null;
  price: MoneyV2;
  priceAfter: MoneyV2 | null;
  shipPromise: string;
  cartAddUrl: string;
  campaign: CampaignState;
  /** Units and price per step, retail last. Empty without a retail price. */
  ladder: LadderStep[];
};

const SECTIONS = [1, 2, 3, 4, 5, 6, 7];
const STEPS = [1, 2, 3, 4];
const FAQ = ['1', '_price', '2', '3', '9', '_cancel', '4', '5', '_duties', '6', '7', '8'];

/** `/products/<handle>?Model=30%C3%9730`: the link selects the variant. */
function variantUrl(handle: string, options: SelectedOption[]): string {
  const query = new URLSearchParams(
    options
      .filter((o) => o.name && o.value && o.value !== 'Default Title')
      .map((o): [string, string] => [o.name, o.value]),
  ).toString();
  return `/products/${handle}${query ? `?${query}` : ''}`;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    key in values ? String(values[key]) : m,
  );
}

/** The price steps as one plain sentence, from `priceTiers`: "Units 1 to
 *  100: 20% off retail. Units 101 to 250: 10% off. From unit 251: retail
 *  price." No struck-through price anywhere (EU Omnibus, art. 6a). */
function ladderSentence(tiers: PriceTier[]): string {
  const parts: string[] = [];
  let from = 1;
  tiers.forEach((tier, i) => {
    const template =
      copyText(i === 0 ? 'preorder.ladder_first' : 'preorder.ladder_step') ??
      'Units {from} to {to}: {off}% off.';
    parts.push(fill(template, {from, to: tier.upTo, off: Math.round(tier.off * 100)}));
    from = tier.upTo + 1;
  });
  parts.push(fill(copyText('preorder.ladder_retail') ?? 'From unit {from}: retail price.', {from}));
  return parts.join(' ');
}

/** 2026-12-31 -> "31 December 2026". */
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export async function loader({context}: Route.LoaderArgs) {
  const globalSoon = comingSoonFlag(context.env);
  const [catalog, statusFlags] = await Promise.all([
    context.catalog.get(),
    fetchStatusFlagsFast(context.env.GITHUB_STATUS_TOKEN, undefined, context.waitUntil),
  ]);
  // Shopify's compare-at price is the retail price the ladder steps up to.
  const retail = new Map<string, number>();
  for (const product of catalog.products) {
    for (const variant of product.variants) {
      if (variant.compare_price != null && variant.compare_price > 0) {
        retail.set(variant.sku, variant.compare_price);
      }
    }
  }
  // The stack's paid batch carries the one fixed ship date on this page.
  const stackShips =
    Object.values(CAMPAIGN.skus)
      .flatMap((entry) => entry.batches)
      .find((batch) => batch.paid && batch.ships?.trim())
      ?.ships?.trim() ?? null;

  const rows: TrackerRow[] = toCards(catalog).flatMap((card) =>
    card.variants.nodes.flatMap((v): TrackerRow[] => {
      if (!v.campaign || !v.sku || !v.shipPromise) return [];
      const status = resolveStatus(card.handle, globalSoon, statusFlags, v.availability);
      if (!isPurchasableStatus(status)) return [];
      return [
        {
          sku: v.sku,
          handle: card.handle,
          url: variantUrl(card.handle, v.selectedOptions),
          product: card.title,
          variant: v.title === 'Default Title' ? '' : v.title,
          image: v.image,
          price: v.price,
          priceAfter: v.priceAfter,
          shipPromise: v.shipPromise,
          cartAddUrl: v.cartAddUrl,
          campaign: v.campaign,
          ladder: retail.has(v.sku) ? priceLadder(retail.get(v.sku)!, CAMPAIGN.priceTiers) : [],
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
    ladder: ladderSentence(CAMPAIGN.priceTiers),
    stackShips,
    endsOn: longDate(CAMPAIGN.endsOn),
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
  const {rows, ladder, stackShips, endsOn, unavailable, summary} = useLoaderData<typeof loader>();
  // Step and FAQ texts that carry campaign numbers are filled from
  // content/preorders.json, so the page cannot drift from the price the
  // Worker writes to Shopify.
  const values = {ladder, stack_ships: stackShips ?? '', ends_on: endsOn};
  const filled = (id: string): string | null => {
    const text = copyText(id);
    return text ? fill(text, values) : null;
  };
  const updates = copy('preorder.updates');
  // Entries are "YYYY-MM-DD · text", newest first, never edited: a
  // correction is a new entry. The section stays hidden until the first one.
  const updateList = (Array.isArray(updates) ? updates.filter((u) => u.trim()) : []).map((raw) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s*[·:]\s*(.+)$/.exec(raw.trim());
    return {raw, date: m?.[1] ?? null, text: m?.[2] ?? raw};
  });

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

      <section className="editorial-section" id="how-it-works">
        <Txt id="preorder.steps_title" as="h2" className="editorial-section-title" />
        <ol className="preorder-steps">
          {STEPS.map((n) => {
            const id = `preorder.step${n}_body`;
            const text = filled(id);
            return (
              <li className="preorder-step" key={n}>
                <span className="preorder-step-n" aria-hidden="true">
                  {n}
                </span>
                <Txt id={`preorder.step${n}_title`} as="h3" className="preorder-step-title" />
                {text && /\{\w+\}/.test(copyText(id) ?? '') ? (
                  <p className="preorder-step-body">{text}</p>
                ) : (
                  <Txt id={id} as="p" className="preorder-step-body" />
                )}
              </li>
            );
          })}
        </ol>
      </section>

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
          {n === 7 ? <TeamStrip /> : null}
        </section>
      ))}

      <section className="editorial-section" id="questions">
        <Txt id="preorder.faq_title" as="h2" className="editorial-section-title" />
        <div className="preorder-faq">
          {FAQ.map((n) => {
            const answerId = `preorder.faq_a${n}`;
            const raw = copyText(answerId) ?? '';
            if (!copyText(`preorder.faq_q${n}`) || !raw) return null;
            return (
              <details className="preorder-faq-item" key={n} id={`faq${n}`}>
                <summary className="preorder-faq-q">
                  <Txt id={`preorder.faq_q${n}`} />
                </summary>
                {/\{\w+\}/.test(raw) ? (
                  <p className="preorder-faq-a">{filled(answerId)}</p>
                ) : (
                  <Txt id={answerId} as="p" className="preorder-faq-a" />
                )}
              </details>
            );
          })}
        </div>
      </section>

      {updateList.length ? (
        <section className="editorial-section" id="updates">
          <Txt id="preorder.updates_title" as="h2" className="editorial-section-title" />
          <Txt id="preorder.updates_lead" as="p" />
          {updateList[0].date ? (
            <p className="preorder-updated">
              {copyText('preorder.updates_last') ?? 'Last updated'}{' '}
              <time dateTime={updateList[0].date}>{updateList[0].date}</time>
            </p>
          ) : null}
          <ol className="preorder-updates">
            {updateList.map((entry) => (
              <li className="preorder-update" key={entry.raw}>
                {entry.date ? <time dateTime={entry.date}>{entry.date}</time> : null}
                <span>{entry.text}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
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
        to={row.url}
        className="preorder-track-media"
        aria-hidden="true"
        tabIndex={-1}
      >
        {row.image ? (
          <img src={shopifyImageUrl(row.image.url, 144)} alt="" loading="lazy" width={72} height={72} />
        ) : (
          <span className="preorder-track-initial">{row.product.slice(4, 5) || row.product[0]}</span>
        )}
      </Link>
      <div className="preorder-track-body">
        <div className="preorder-track-head">
          <h3 className="preorder-track-title">
            <Link prefetch="viewport" to={row.url}>
              {row.product} {row.variant ? <span>{row.variant}</span> : null}
            </Link>
          </h3>
          <span className="preorder-track-price">
            {formatPrice(row.price.amount, row.price.currencyCode)}
            {row.priceAfter && row.ladder.length < 2 ? (
              <em>
                {(copyText('preorder.track_price_after') ?? 'then {price}').replace(
                  '{price}',
                  formatPrice(row.priceAfter.amount, row.priceAfter.currencyCode),
                )}
              </em>
            ) : null}
          </span>
        </div>
        <PreorderMeter campaign={row.campaign} priceAfter={row.priceAfter} compact />
        {row.ladder.length > 1 ? <PriceLadder row={row} /> : null}
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

/**
 * The whole price ladder of one product option as plain text: every step
 * with its units and price, the current one marked. No struck-through
 * price: the retail figure is the last step, not a "was" price.
 */
function PriceLadder({row}: {row: TrackerRow}) {
  const next = row.campaign.ordered + 1;
  const currency = row.price.currencyCode;
  return (
    <p className="preorder-ladder">
      <span className="preorder-ladder-label">
        {copyText('preorder.track_ladder_label') ?? 'Price per unit'}
      </span>
      {row.ladder.map((step) => {
        const current = next >= step.from && (step.to === null || next <= step.to);
        const units =
          step.to === null
            ? fill(copyText('preorder.track_ladder_units_open') ?? 'from unit {from}', {from: step.from})
            : fill(copyText('preorder.track_ladder_units') ?? 'units {from}-{to}', {
                from: step.from,
                to: step.to,
              });
        return (
          <span
            key={step.from}
            className={`preorder-ladder-step${current ? ' is-current' : ''}`}
            aria-current={current ? 'true' : undefined}
          >
            {formatPrice(step.price, currency)} <span>{units}</span>
            {current ? (
              <em>{copyText('preorder.track_ladder_now') ?? 'now'}</em>
            ) : null}
          </span>
        );
      })}
    </p>
  );
}
