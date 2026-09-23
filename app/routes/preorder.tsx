import type {Route} from './+types/preorder';
import {CreditCard, Globe, RotateCcw, Target} from 'lucide-react';
import type {ComponentType} from 'react';
import {Link, useLoaderData} from 'react-router';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {StepBar} from '~/components/PreorderMeter';
import {shipWord} from '~/components/ShipChip';
import {AddToCartButton} from '~/components/AddToCartButton';
import {Txt} from '~/components/Txt';
import {copy, copyText} from '~/lib/copy';
import {formatPrice, toCards} from '~/lib/catalog';
import {comingSoonFlag} from '~/lib/coming-soon';
import {
  isPurchasableStatus,
  PRODUCT_CONTENT,
  resolveStatus,
  shipMonth,
  variantDisplayName,
} from '~/lib/product-content';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import {CAMPAIGN} from '~/lib/catalog-client';
import {
  campaignDate,
  latestShipDay,
  priceLadder,
  shortCampaignDate,
  type CampaignState,
  type LadderStep,
} from '~/lib/preorder-campaign';
import {stepBarView} from '~/lib/preorder-meter';
import type {MoneyV2, ProductImage, SelectedOption} from '~/lib/product-shapes';

/**
 * The pre-order page: the ship dates as a timeline, the price steps once,
 * the stack and the funding targets as product cards with a step bar each,
 * the terms as four tiles, six short questions and the dated updates.
 *
 * Words live in `content/copy/preorder.json`. The cards read the
 * campaign-aware catalog, so every card carries the same numbers as its
 * product page, and a card appears only for a variant the status system
 * lets the shop sell.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('preorder.meta_title') ?? 'Pre-orders',
    description: copyText('preorder.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/preorder`,
  });

type Row = {
  sku: string;
  handle: string;
  /** Product page link that opens this exact variant. */
  url: string;
  product: string;
  variant: string;
  image: ProductImage | null;
  price: MoneyV2;
  shipPromise: string;
  cartAddUrl: string;
  campaign: CampaignState;
  /** Units and price per step, retail last. Empty without a retail price. */
  ladder: LadderStep[];
  /** "/ motor" for a part sold per piece, from the product content. */
  priceUnit: string | null;
};

const FAQ = ['pay', 'cancel', 'missed', 'eta', 'duties', 'risks'];

const TERMS: Array<{key: string; Icon: ComponentType<{size?: number; 'aria-hidden'?: boolean}>}> = [
  {key: 'pay', Icon: CreditCard},
  {key: 'cancel', Icon: RotateCcw},
  {key: 'missed', Icon: Target},
  {key: 'ships', Icon: Globe},
];

/** `/products/<handle>?Model=30%C3%9730`: the link selects the variant. */
function variantUrl(handle: string, options: SelectedOption[]): string {
  const query = new URLSearchParams(
    options
      .filter((o) => o.name && o.value && o.value !== 'Default Title')
      .map((o): [string, string] => [o.name, o.value]),
  ).toString();
  return `/products/${handle}${query ? `?${query}` : ''}`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "ships late October 2026" as a day for the timeline: early 5th, mid
 *  15th, late 25th. Null when the promise names no month. */
function promiseDay(promise: string | null): string | null {
  const m = /\b(early|mid|late)?\s*([A-Za-z]+) (\d{4})\b/i.exec(promise ?? '');
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  const day = {early: 5, mid: 15, late: 25}[(m[1] ?? 'mid').toLowerCase() as 'mid'] ?? 15;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function loader({context}: Route.LoaderArgs) {
  const globalSoon = comingSoonFlag(context.env);
  const [catalog, statusFlags] = await Promise.all([
    context.catalog.get(),
    fetchStatusFlagsFast(context.env.GITHUB_STATUS_TOKEN, undefined, context.waitUntil),
  ]);
  // Shopify's compare-at price is the retail price the steps climb to.
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

  const rows: Row[] = toCards(catalog).flatMap((card) =>
    card.variants.nodes.flatMap((v): Row[] => {
      if (!v.campaign || !v.sku || !v.shipPromise) return [];
      const status = resolveStatus(card.handle, globalSoon, statusFlags, v.availability);
      if (!isPurchasableStatus(status)) return [];
      const unit = PRODUCT_CONTENT[card.handle]?.priceUnit ?? null;
      return [
        {
          sku: v.sku,
          handle: card.handle,
          url: variantUrl(card.handle, v.selectedOptions),
          product: card.title,
          variant: v.title === 'Default Title' ? '' : variantDisplayName(card.handle, v.title),
          image: v.image,
          price: v.price,
          shipPromise: v.shipPromise,
          cartAddUrl: v.cartAddUrl,
          campaign: v.campaign,
          ladder: retail.has(v.sku) ? priceLadder(retail.get(v.sku)!, CAMPAIGN.priceTiers) : [],
          priceUnit: unit ? unit.replace(/^per\s+/i, '/ ') : null,
        },
      ];
    }),
  );

  const latestDay = latestShipDay(CAMPAIGN);
  return {
    rows,
    stackMonth: shipMonth(stackShips),
    stackDay: promiseDay(stackShips),
    endsDay: CAMPAIGN.endsOn,
    etaDay: latestDay,
    ends: shortCampaignDate(campaignDate(CAMPAIGN.endsOn)) ?? CAMPAIGN.endsOn,
    eta: shortCampaignDate(campaignDate(latestDay)) ?? latestDay,
    // The server's day, so the "Today" marker renders the same on hydration.
    today: new Date().toISOString().slice(0, 10),
    stepEnds: CAMPAIGN.priceTiers.map((tier) => tier.upTo),
    unavailable: catalog.campaign_counts === 'unavailable',
  };
}

export default function PreorderRoute() {
  const data = useLoaderData<typeof loader>();
  const {rows, stackMonth, ends, eta, unavailable} = data;
  const updates = copy('preorder.updates');
  // Entries are "YYYY-MM-DD · text", newest first, never edited: a
  // correction is a new entry. The section stays hidden until the first one.
  const updateList = (Array.isArray(updates) ? updates.filter((u) => u.trim()) : []).map((raw) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s*[·:]\s*(.+)$/.exec(raw.trim());
    return {raw, date: m?.[1] ?? null, text: m?.[2] ?? raw};
  });

  // FC before ESC, then by size: 20x20 FC, 20x20 ESC, 30x30 FC, 30x30 ESC.
  const stackRows = rows
    .filter((r) => r.campaign.paidStock)
    .sort((a, b) => a.variant.localeCompare(b.variant) || b.product.localeCompare(a.product));
  const targetRows = rows.filter((r) => !r.campaign.paidStock);
  const dot = ' · ';

  return (
    <EditorialShell slug="preorder" rail={false} reveal={false} pageClassName="preorder-page">
      <Txt id="preorder.title" as="h1" className="po-title" />

      <Timeline data={data} />
      <StepLegend />

      {unavailable ? (
        <Txt id="preorder.strip_unavailable" as="p" className="po-empty" />
      ) : !rows.length ? (
        <Txt id="preorder.tracker_empty" as="p" className="po-empty" />
      ) : null}

      {!unavailable && stackRows.length ? (
        <section className="po-group" id="stack">
          <h2 className="po-group-title">
            <Txt id="preorder.stack_title" />
            {stackMonth ? <span className="po-group-meta">{dot + shipWord('ships', stackMonth)}</span> : null}
          </h2>
          <Cards rows={stackRows} stepEnds={data.stepEnds} eta={eta} />
        </section>
      ) : null}

      {!unavailable && targetRows.length ? (
        <section className="po-group" id="targets">
          <h2 className="po-group-title">
            <Txt id="preorder.targets_title" />
            <span className="po-group-meta">{dot + shipWord('deadline', ends)}</span>
            <span className="po-group-meta">{dot + shipWord('eta', eta)}</span>
          </h2>
          {stackMonth ? (
            <p className="po-group-line">
              {(copyText('preorder.targets_line') ?? '').replace('{month}', stackMonth)}
            </p>
          ) : null}
          <Cards rows={targetRows} stepEnds={data.stepEnds} eta={eta} />
        </section>
      ) : null}

      <ul className="po-terms" aria-label={copyText('preorder.terms_label') ?? 'Pre-order terms'}>
        {TERMS.map(({key, Icon}) => (
          <li key={key}>
            <Icon size={22} aria-hidden />
            <Txt id={`preorder.terms_${key}`} as="strong" />
            <Txt id={`preorder.terms_${key}_sub`} />
          </li>
        ))}
      </ul>

      <section className="po-faq" id="questions">
        <Txt id="preorder.faq_title" as="h2" className="po-group-title" />
        {FAQ.map((key) =>
          copyText(`preorder.faq_q_${key}`) ? (
            <details className="po-faq-item" key={key}>
              <summary>
                <Txt id={`preorder.faq_q_${key}`} />
              </summary>
              <Txt id={`preorder.faq_a_${key}`} as="p" />
            </details>
          ) : null,
        )}
      </section>

      {updateList.length ? (
        <section className="po-updates" id="updates">
          <Txt id="preorder.updates_title" as="h2" className="po-group-title" />
          <ol>
            {updateList.map((entry) => (
              <li key={entry.raw}>
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

const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Two lanes on one time axis: the stack's ship month, and the funding
 * targets' deadline and latest ship date, with a "Today" marker. On a
 * phone the lanes read as two rows of dates.
 */
function Timeline({data}: {data: ReturnType<typeof useLoaderData<typeof loader>>}) {
  const {stackDay, stackMonth, endsDay, etaDay, ends, eta, today} = data;
  const days = [today, endsDay, etaDay, ...(stackDay ? [stackDay] : [])].map(dayMs);
  const first = new Date(Math.min(...days));
  const last = new Date(Math.max(...days));
  const start = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  const end = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1);
  const at = (iso: string) => `${(((dayMs(iso) - start) / (end - start)) * 100).toFixed(2)}%`;
  const todayPos = at(today);

  const lanes = [
    stackDay && stackMonth
      ? {
          key: 'stack',
          label: copyText('preorder.timeline_stack') ?? 'Stack',
          events: [{day: stackDay, date: stackMonth, what: copyText('preorder.timeline_ships') ?? 'Ships', kind: 'ship'}],
        }
      : null,
    {
      key: 'targets',
      label: copyText('preorder.timeline_targets') ?? 'RX · Frames · Motors',
      events: [
        {day: endsDay, date: ends, what: copyText('preorder.timeline_deadline') ?? 'Deadline', kind: 'deadline'},
        {day: etaDay, date: eta, what: copyText('preorder.timeline_eta') ?? 'Ships if funded', kind: 'eta'},
      ],
    },
  ].filter((lane) => lane !== null);

  const months: Array<{key: number; pos: string; label: string}> = [];
  for (let t = start; t < end; ) {
    const d = new Date(t);
    const label = new Intl.DateTimeFormat('en-US', {month: 'short', timeZone: 'UTC'}).format(d);
    months.push({
      key: t,
      pos: `${(((t - start) / (end - start)) * 100).toFixed(2)}%`,
      label: d.getUTCMonth() === 0 ? `${label} ${d.getUTCFullYear()}` : label,
    });
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  return (
    <figure className="po-timeline" aria-label={copyText('preorder.timeline_label') ?? 'Ship dates'}>
      {lanes.map((lane) => {
        const lastDay = lane.events[lane.events.length - 1].day;
        const from = Math.min(dayMs(today), dayMs(lane.events[0].day));
        return (
          <div className="po-lane" key={lane.key} data-lane={lane.key}>
            <span className="po-lane-label">{lane.label}</span>
            <div className="po-lane-track">
              <span
                className="po-lane-line"
                style={{
                  left: `${(((from - start) / (end - start)) * 100).toFixed(2)}%`,
                  width: `${(((dayMs(lastDay) - from) / (end - start)) * 100).toFixed(2)}%`,
                }}
              />
              {lane.events.map((e) => (
                <span className="po-event" data-kind={e.kind} key={e.kind} style={{left: at(e.day)}}>
                  <span className="po-event-dot" aria-hidden="true" />
                  <strong>{e.date}</strong>
                  <span>{e.what}</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
      <div className="po-axis" aria-hidden="true">
        {months.map((m) => (
          <span key={m.key} style={{left: m.pos}}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="po-today" aria-hidden="true">
        <span style={{left: todayPos}}>{copyText('preorder.timeline_today') ?? 'Today'}</span>
      </div>
    </figure>
  );
}

/** The price steps once, for every card: "Units 1-100 · Early bird". */
function StepLegend() {
  const names = copy('preorder.legend_steps');
  const labels = Array.isArray(names) ? names : [];
  const cells: string[] = [];
  let from = 1;
  for (const tier of CAMPAIGN.priceTiers) {
    cells.push(`${from}-${tier.upTo}`);
    from = tier.upTo + 1;
  }
  cells.push(`${from}+`);
  return (
    <div className="po-legend">
      <span className="po-legend-label">
        <Txt id="preorder.legend_label" />
      </span>
      <ol>
        {cells.map((units, i) => (
          <li key={units}>
            <span className="po-legend-units">
              {i === 0 ? `${copyText('preorder.legend_units') ?? 'Units'} ` : ''}
              {units}
            </span>
            <span>{labels[i] ?? ''}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Cards({rows, stepEnds, eta}: {rows: Row[]; stepEnds: number[]; eta: string}) {
  return (
    <ul className="po-cards">
      {rows.map((row) => (
        <Card key={row.sku} row={row} stepEnds={stepEnds} eta={eta} />
      ))}
    </ul>
  );
}

function Card({row, stepEnds, eta}: {row: Row; stepEnds: number[]; eta: string}) {
  const name = row.variant ? `${row.product} ${row.variant}` : row.product;
  const cta = copyText('preorder.card_cta') ?? 'Pre-order';
  const currency = row.price.currencyCode;
  const next = row.campaign.ordered + 1;
  const prices = row.ladder.map((step) => ({
    key: step.from,
    text: formatPrice(step.price, currency),
    current: next >= step.from && (step.to === null || next <= step.to),
  }));
  const bar = stepBarView(row.campaign, stepEnds);
  const funded = `${copyText('preorder.funded') ?? 'Funded'} · ${shipWord('eta', shortCampaignDate(row.campaign.latestShip) ?? shipMonth(row.shipPromise) ?? eta)}`;
  return (
    <li className="po-card">
      <Link prefetch="viewport" to={row.url} className="po-card-media" aria-hidden="true" tabIndex={-1}>
        {row.image ? (
          <img src={shopifyImageUrl(row.image.url, 480)} alt="" loading="lazy" width={240} height={240} />
        ) : null}
      </Link>
      <h3 className="po-card-title">
        <Link prefetch="viewport" to={row.url}>
          {row.product} {row.variant ? <span>{row.variant}</span> : null}
        </Link>
      </h3>
      <p className="po-card-price">
        {formatPrice(row.price.amount, currency)}
        {row.priceUnit ? <span> {row.priceUnit}</span> : null}
      </p>
      <StepBar bar={bar} prices={prices} fundedLabel={funded} />
      <AddToCartButton
        className="po-card-cta"
        href={row.cartAddUrl}
        product={row.handle}
        revenue={{currency, amount: Number(row.price.amount) || 0}}
        ariaLabel={`${cta}: ${name}`}
      >
        {cta}
      </AddToCartButton>
    </li>
  );
}
