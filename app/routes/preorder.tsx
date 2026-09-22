import type {Route} from './+types/preorder';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {useEffect} from 'react';
import {Link, useLoaderData} from 'react-router';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {PreorderMeter} from '~/components/PreorderMeter';
import {AddToCartButton} from '~/components/AddToCartButton';
import {TeamStrip} from '~/components/TeamStrip';
import {Txt} from '~/components/Txt';
import {copy, copyText} from '~/lib/copy';
import {formatPrice, toCards} from '~/lib/catalog';
import {comingSoonFlag} from '~/lib/coming-soon';
import {
  isPurchasableStatus,
  PRODUCT_CONTENT,
  resolveStatus,
  variantCartNote,
  variantDisplayName,
} from '~/lib/product-content';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
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
 * The campaign page: the hero with an at-a-glance card, the model in four
 * steps, the price steps once, then the tracker in two groups (paid stock
 * with its one ship date, funding targets with their one deadline), one
 * compact card per product option, each orderable from here. Then the
 * background sections, the questions, a short Dutch and French summary
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
    canonical: `${SITE_ORIGIN}/preorder`,
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
  /** What one unit of the price buys ("per motor"), from the product content. */
  priceUnit: string | null;
  /** What is not final about this option (the 5" motor's stator and KV),
   *  the same product-content line the cart shows. */
  note: string | null;
};

/** Background sections under the tracker. The model itself is the four
 *  steps at the top; these are what it is, the risks and who runs it. */
const SECTIONS = [1, 6, 7];
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
 *  100: the early-order price. ..." Named steps, never a reduction against
 *  a reference price nobody was charged, and no struck-through price
 *  anywhere (EU Omnibus, art. 6a). */
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

/** The price steps as a row of cells: "Units 1-100" / "Early-order price".
 *  No "off retail": the steps are named, each card lists its own prices. */
function ladderCells(tiers: PriceTier[]): Array<{units: string; price: string}> {
  const cells: Array<{units: string; price: string}> = [];
  let from = 1;
  for (const [i, tier] of tiers.entries()) {
    cells.push({
      units: fill(copyText('preorder.ladder_row_units') ?? 'Units {from}-{to}', {from, to: tier.upTo}),
      price: fill(
        copyText(i === 0 ? 'preorder.ladder_row_first' : 'preorder.ladder_row_off') ??
          (i === 0 ? 'Early-order price' : 'Next price step'),
        {off: Math.round(tier.off * 100)},
      ),
    });
    from = tier.upTo + 1;
  }
  cells.push({
    units: fill(copyText('preorder.ladder_row_open') ?? 'From unit {from}', {from}),
    price: copyText('preorder.ladder_row_retail') ?? 'Standard price',
  });
  return cells;
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
          variant: v.title === 'Default Title' ? '' : variantDisplayName(card.handle, v.title),
          image: v.image,
          price: v.price,
          priceAfter: v.priceAfter,
          shipPromise: v.shipPromise,
          cartAddUrl: v.cartAddUrl,
          campaign: v.campaign,
          ladder: retail.has(v.sku) ? priceLadder(retail.get(v.sku)!, CAMPAIGN.priceTiers) : [],
          priceUnit: PRODUCT_CONTENT[card.handle]?.priceUnit ?? null,
          note: variantCartNote(card.handle, v.title),
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
    ladderCells: ladderCells(CAMPAIGN.priceTiers),
    stackShips,
    endsOn: longDate(CAMPAIGN.endsOn),
    unavailable: catalog.campaign_counts === 'unavailable',
    summary: {
      // One figure per board and size: a single total ("1000 left") reads
      // like 1000 of one board, while each option has its own batch.
      // Flight controller before ESC, then by size: the stack's order.
      stackLeft: [...stock]
        .sort((a, b) => b.product.localeCompare(a.product) || a.variant.localeCompare(b.variant))
        .map((r) => ({
        sku: r.sku,
        name: r.variant ? `${r.product} ${r.variant}` : r.product,
        left: r.campaign.batchUnits - r.campaign.batchOrdered,
        units: r.campaign.batchUnits,
      })),
      ordered: ordered > 0 ? ordered : null,
      // Shown once a target is reached; "0 / 8" only discourages.
      reached: funding.some((r) => r.campaign.targetReached)
        ? `${funding.filter((r) => r.campaign.targetReached).length} / ${funding.length}`
        : null,
    },
  };
}

export default function PreorderRoute() {
  const {rows, ladder, ladderCells, stackShips, endsOn, unavailable, summary} =
    useLoaderData<typeof loader>();
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

  type Cell = {key: string; label: string; value: string};
  const stackCells: Cell[] = summary.stackLeft.map((row) => ({
    key: `stack-${row.sku}`,
    label: fill(copyText('preorder.strip_stack_each') ?? '{name}', {name: row.name}),
    value: fill(copyText('preorder.strip_stack_value') ?? '{left} of {units} left', {
      left: row.left,
      units: row.units,
    }),
  }));
  const cells: Cell[] = [
    ...stackCells,
    summary.reached !== null
      ? {key: 'reached', label: copyText('preorder.strip_reached_label') ?? '', value: summary.reached}
      : null,
    summary.ordered !== null
      ? {key: 'ordered', label: copyText('preorder.strip_ordered_label') ?? '', value: String(summary.ordered)}
      : null,
  ].filter((c): c is Cell => c !== null);

  // Flight controller before ESC, then by size: the stack's order.
  // The footer links to #nl and #fr: open that summary on arrival.
  useEffect(() => {
    const open = () => {
      const target = document.getElementById(window.location.hash.slice(1));
      if (target instanceof HTMLDetailsElement && target.classList.contains('preorder-lang')) {
        target.open = true;
        target.scrollIntoView();
      }
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);

  const paidRows = rows
    .filter((r) => r.campaign.paidStock)
    .sort((a, b) => b.product.localeCompare(a.product) || a.variant.localeCompare(b.variant));
  const targetRows = rows.filter((r) => !r.campaign.paidStock);

  return (
    <EditorialShell slug="preorder" rail={false} pageClassName="preorder-page">
      <header className="editorial-hero preorder-hero">
        <div className="preorder-hero-text">
          <Txt id="preorder.title" as="h1" className="editorial-title" />
          <Txt id="preorder.lead" as="p" className="editorial-lead" />
          <div className="editorial-cta">
            <a className="editorial-cta-primary" href="#tracker">
              <Txt id="preorder.cta_primary" />
            </a>
            <Link prefetch="viewport" to="/production" className="editorial-cta-secondary">
              <Txt id="preorder.cta_secondary" />
            </Link>
          </div>
        </div>
        <aside
          className="preorder-glance"
          aria-label={copyText('preorder.glance_title') ?? 'At a glance'}
        >
          <Txt id="preorder.glance_title" as="h2" className="preorder-glance-title" />
          {stackShips ? <p className="preorder-glance-line">{filled('preorder.glance_stack')}</p> : null}
          {unavailable ? (
            <Txt id="preorder.strip_unavailable" as="p" className="preorder-empty" />
          ) : cells.length ? (
            <>
              <Txt id="preorder.strip_caption" as="p" className="preorder-strip-caption" />
              <dl className="preorder-strip">
                {cells.map((cell) => (
                  <div className="preorder-strip-cell" key={cell.key}>
                    <dt className="preorder-strip-label">{cell.label}</dt>
                    <dd className="preorder-strip-value">{cell.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
          <p className="preorder-glance-line">{filled('preorder.glance_targets')}</p>
        </aside>
      </header>

      <section className="editorial-section preorder-wide" id="how-it-works">
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

      <section className="editorial-section preorder-wide" id="tracker">
        <Txt id="preorder.tracker_title" as="h2" className="editorial-section-title" />
        <Txt id="preorder.tracker_lead" as="p" className="preorder-tracker-lead" />
        <div className="preorder-price-steps">
          <Txt id="preorder.price_steps_title" as="h3" className="preorder-price-steps-title" />
          <ol className="preorder-price-steps-row">
            {ladderCells.map((cell) => (
              <li key={cell.units}>
                <span className="preorder-price-steps-units">{cell.units}</span>
                <span className="preorder-price-steps-price">{cell.price}</span>
              </li>
            ))}
          </ol>
        </div>
        {rows.length ? (
          <>
            {paidRows.length ? (
              <TrackerGroup
                title={filled('preorder.group_paid_title') ?? ''}
                lead={filled('preorder.group_paid_lead')}
                rows={paidRows}
              />
            ) : null}
            {targetRows.length ? (
              <TrackerGroup
                title={filled('preorder.group_target_title') ?? ''}
                lead={filled('preorder.group_target_lead')}
                rows={targetRows}
              />
            ) : null}
          </>
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

      {copyText('preorder.gift_title') ? (
        <section className="editorial-section" id="gift">
          <Txt id="preorder.gift_title" as="h2" className="editorial-section-title" />
          <Txt id="preorder.gift_body" as="p" />
          <Txt id="preorder.gift_nl" as="p" lang="nl" />
          <Txt id="preorder.gift_fr" as="p" lang="fr" />
        </section>
      ) : null}

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

      {/* The shop is in English; these two short summaries give Dutch and
          French readers the preorder rules in their own language. The
          terms, which apply, exist in both. */}
      <section className="editorial-section preorder-langs">
        {(['nl', 'fr'] as const).map((lang) =>
          copyText(`preorder.${lang}_title`) ? (
            <details className="preorder-lang" id={lang} lang={lang} key={lang}>
              <summary className="preorder-lang-title">
                <Txt id={`preorder.${lang}_title`} />
              </summary>
              <Txt id={`preorder.${lang}_body`} as="p" />
            </details>
          ) : null,
        )}
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

/** One group of the tracker: a heading that carries the ship rule once,
 *  then a grid of compact product cards. */
function TrackerGroup({
  title,
  lead,
  rows,
}: {
  title: string;
  lead: string | null;
  rows: TrackerRow[];
}) {
  return (
    <div className="preorder-group">
      <h3 className="preorder-group-title">{title}</h3>
      {lead ? <p className="preorder-group-lead">{lead}</p> : null}
      <ul className="preorder-tracker">
        {rows.map((row) => (
          <TrackerCard key={row.sku} row={row} />
        ))}
      </ul>
    </div>
  );
}

/** A funding-target option's design stage, in the product page's words
 *  (content/copy/product-chrome.json), so a buyer sees before paying that a
 *  frame or motor is not yet tested. */
function stageText(status: string | undefined): string | null {
  if (status === 'in-progress')
    return copyText('product-chrome.stage_in_progress') ?? 'Design stage: prototypes ordered, not yet tested';
  if (status === 'alpha')
    return copyText('product-chrome.stage_alpha') ?? 'Design stage: prototypes built and flown by testers';
  return null;
}

function TrackerCard({row}: {row: TrackerRow}) {
  const roadmapStatus = useRoadmapStatusResolver();
  const stage = row.campaign.paidStock ? null : stageText(roadmapStatus(row.handle));
  const name = row.variant ? `${row.product} ${row.variant}` : row.product;
  const cta = copyText('product-chrome.buy_cta_preorder') ?? 'Add to cart';
  const currency = row.price.currencyCode;
  // The step after the one the next unit falls in: what the price becomes.
  const nextUnit = row.campaign.ordered + 1;
  const current = row.ladder.findIndex(
    (step) => nextUnit >= step.from && (step.to === null || nextUnit <= step.to),
  );
  const nextStep = current >= 0 ? row.ladder[current + 1] : undefined;
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
          <img src={shopifyImageUrl(row.image.url, 128)} alt="" loading="lazy" width={64} height={64} />
        ) : (
          <span className="preorder-track-initial">{row.product.slice(4, 5) || row.product[0]}</span>
        )}
      </Link>
      <div className="preorder-track-body">
        <h4 className="preorder-track-title">
          <Link prefetch="viewport" to={row.url}>
            {row.product} {row.variant ? <span>{row.variant}</span> : null}
          </Link>
        </h4>
        <p className="preorder-track-price">
          <strong>{formatPrice(row.price.amount, currency)}</strong>
          {row.priceUnit ? (
            <span className="preorder-track-unit">
              {' '}
              {row.priceUnit}
              {row.priceUnit === 'per motor'
                ? ` · ${copyText('preorder.track_per_quad') ?? '4 per quad'}`
                : ''}
            </span>
          ) : null}
          {nextStep ? (
            <span className="preorder-track-next">
              {' '}
              {fill(copyText('preorder.track_next') ?? 'then {price} from unit {from}', {
                price: formatPrice(nextStep.price, currency),
                from: nextStep.from,
              })}
            </span>
          ) : row.priceAfter && row.ladder.length < 2 ? (
            <span className="preorder-track-next">
              {' '}
              {(copyText('preorder.track_price_after') ?? 'then {price}').replace(
                '{price}',
                formatPrice(row.priceAfter.amount, row.priceAfter.currencyCode),
              )}
            </span>
          ) : null}
        </p>
        {stage ? <p className="preorder-track-stage text-[13px]! leading-snug! text-[var(--color-text-muted)]">{stage}</p> : null}
        {row.note ? (
          <p className="preorder-track-note text-[13px]! leading-snug! text-[var(--color-gold-text)]">{row.note}</p>
        ) : null}
        <PreorderMeter campaign={row.campaign} priceAfter={row.priceAfter} compact />
        <div className="preorder-track-foot">
          {row.ladder.length > 1 ? (
            <details className="preorder-track-steps">
              <summary>{copyText('preorder.track_steps_summary') ?? 'All price steps'}</summary>
              <PriceLadder row={row} />
            </details>
          ) : (
            <span />
          )}
          <AddToCartButton
            className="preorder-track-cta"
            href={row.cartAddUrl}
            product={row.handle}
            revenue={{currency: row.price.currencyCode, amount: Number(row.price.amount) || 0}}
            ariaLabel={`${cta}: ${name}`}
          >
            {cta}
          </AddToCartButton>
        </div>
      </div>
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
  const now = copyText('preorder.track_ladder_now') ?? 'now';
  return (
    <table className="preorder-ladder">
      <caption className="sr-only">
        {copyText('preorder.track_ladder_label') ?? 'Price per unit'}
      </caption>
      <tbody>
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
            <tr
              key={step.from}
              className={`preorder-ladder-step${current ? ' is-current' : ''}`}
              aria-current={current ? 'true' : undefined}
            >
              <th scope="row">{units}</th>
              <td>
                {formatPrice(step.price, currency)}
                {current ? (
                  <>
                    {' '}
                    <em>({now})</em>
                  </>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
