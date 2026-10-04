import type {Route} from './+types/preorder';
import {ChatFpvWidget} from '~/components/ChatFpvWidget';
import {chatFpvWidgetSrc} from '~/lib/support/chatfpv';
import {InfoHint} from '~/components/InfoHint';
import {Link, useLoaderData, useRouteLoaderData} from 'react-router';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {StepBar} from '~/components/PreorderMeter';
import {EarlyBirdNote} from '~/components/EarlyPriceCue';
import {preorderWords} from '~/components/Availability';
import {batchPhrase, currentBatch} from '~/lib/availability';
import {shipWord} from '~/components/ShipChip';
import {AddToCartButton} from '~/components/AddToCartButton';
import {NewsletterSignup} from '~/components/NewsletterSignup';
import {Txt} from '~/components/Txt';
import {copy, copyText} from '~/lib/copy';
import {formatPrice, toCards} from '~/lib/catalog';
import {comingSoonFlag} from '~/lib/coming-soon';
import {
  isPurchasableStatus,
  PRODUCT_CONTENT,
  imagesAreRenders,
  resolveStatus,
  setSize,
  shipMonth,
  variantDisplayName,
} from '~/lib/product-content';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import {CAMPAIGN} from '~/lib/catalog-client';
import {
  campaignDate,
  datedShipParts,
  latestShipDay,
  shortCampaignDate,
  tiersFor,
  type CampaignState,
} from '~/lib/preorder-campaign';
import {stepBarView} from '~/lib/preorder-meter';
import type {MoneyV2, ProductImage, SelectedOption} from '~/lib/product-shapes';

/**
 * Ship dates and batch progress stay visible; supporting explanations
 * and price schedules open on demand.
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
    // Its own 1200x630 card: /preorder is the page shared at launch.
    image: '/og-preorder.png',
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
  /** Units one Pre-order adds: a set for a part used in sets. */
  quantity: number;
  campaign: CampaignState;
  /** Last unit of each price step, for this SKU. */
  stepEnds: number[];
  /** "/ motor" for a part sold per piece, from the product content. */
  priceUnit: string | null;
  /** The image is a CAD render, tagged like the home tiles. */
  render: boolean;
  /** The price is an early bird preorder price. */
  early: boolean;
};

const FAQ = ['pay', 'cancel', 'missed', 'eta', 'shops', 'risks'];

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

/** "ships early November 2026" as a day for the timeline: early 5th, mid
 *  15th, late 25th. Null when the promise names no month. */
function promiseDay(promise: string | null): string | null {
  const m = /\b(early|mid|late)?\s*([A-Za-z]+) (\d{4})\b/i.exec(promise ?? '');
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  const day = {early: 5, mid: 15, late: 25}[(m[1] ?? 'mid').toLowerCase() as 'mid'] ?? 15;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** An add-to-cart link with its `qty` set. */
function withQuantity(href: string, quantity: number): string {
  const url = new URL(href, 'https://opendrone.be');
  if (!url.searchParams.has('qty')) return href;
  url.searchParams.set('qty', String(quantity));
  return href.startsWith('http') ? url.toString() : `${url.pathname}${url.search}`;
}

export async function loader({context}: Route.LoaderArgs) {
  // ChatFPV widget iframe address; null unless CHATFPV_WIDGET_ENABLED is "1".
  const chatfpvWidget = chatFpvWidgetSrc(context.env, 'preorder');
  const globalSoon = comingSoonFlag(context.env);
  const [catalog, statusFlags] = await Promise.all([
    context.catalog.forBuyer(),
    fetchStatusFlagsFast(context.env.GITHUB_STATUS_TOKEN, undefined, context.waitUntil),
  ]);
  // A US buyer (US sales open): no paid batch ships to the US, so every
  // part waits for its funding target and the page drops the stack lane.
  const us = context.catalog.region === 'US';
  const international = context.catalog.region === 'INT';
  // The stack's paid batch carries the one fixed ship date on this page.
  const paidShips =
    Object.values(CAMPAIGN.skus)
      .flatMap((entry) => entry.batches)
      .find((batch) => batch.paid && batch.ships?.trim())
      ?.ships?.trim() ?? null;
  const stackShips = us || international ? null : paidShips;

  const rows: Row[] = toCards(catalog).flatMap((card) =>
    card.variants.nodes.flatMap((v): Row[] => {
      // Only the campaign's main parts: accessories that ship with them are
      // sold on their own pages, not tracked here.
      if (!v.campaign || !v.sku || !v.shipPromise || !CAMPAIGN.skus[v.sku]) return [];
      const status = resolveStatus(card.handle, globalSoon, statusFlags, v.availability);
      if (!isPurchasableStatus(status)) return [];
      const unit = PRODUCT_CONTENT[card.handle]?.priceUnit ?? null;
      // A part used in sets (4 motors per quad) adds one set, as its
      // product page does.
      const set = setSize(card.handle);
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
          cartAddUrl: set ? withQuantity(v.cartAddUrl, set) : v.cartAddUrl,
          quantity: set ?? 1,
          campaign: v.campaign,
          stepEnds: tiersFor(CAMPAIGN, v.sku).map((tier) => tier.upTo),
          priceUnit: unit ? unit.replace(/^per\s+/i, '/ ') : null,
          render: imagesAreRenders(card.handle),
          early: v.earlyPrice != null,
        },
      ];
    }),
  );

  const latestDay = latestShipDay(CAMPAIGN);
  return {
    rows,
    stackMonth: shipMonth(stackShips),
    stackWhen: datedShipParts(stackShips)?.when ?? null,
    stackDay: promiseDay(stackShips),
    endsDay: CAMPAIGN.endsOn,
    etaDay: latestDay,
    ends: shortCampaignDate(campaignDate(CAMPAIGN.endsOn)) ?? CAMPAIGN.endsOn,
    eta: shortCampaignDate(campaignDate(latestDay)) ?? latestDay,
    // The server's day, so the "Today" marker renders the same on hydration.
    today: new Date().toISOString().slice(0, 10),
    unavailable: catalog.campaign_counts === 'unavailable',
    chatfpvWidget,
    // Present only for a US buyer: the US copy on this page.
    ...(us ? {us: true as const} : {}),
    international,
    // Its FC and ESC batch 1 is EU stock: the month it ships and the batch
    // the US buyer gets instead.
    usBatchNote:
      (us || international) && paidShips
        ? {
            first: shipMonth(paidShips),
            batch: new Intl.DateTimeFormat('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(
              new Date(`${latestDay}T00:00:00Z`),
            ),
          }
        : null,
  };
}

export default function PreorderRoute() {
  const data = useLoaderData<typeof loader>();
  const {rows, stackMonth, stackWhen, ends, eta, unavailable} = data;
  const usBatchNote = 'usBatchNote' in data ? data.usBatchNote : null;
  const us = 'us' in data && data.us === true;
  const international = data.international;
  const rootData = useRouteLoaderData('root') as {turnstileSiteKey?: string | null} | undefined;
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

  return (
    <EditorialShell slug="preorder" rail={false} reveal={false} pageClassName="preorder-page">
      <header className="po-header">
        <div>
          <Txt id="preorder.title" as="h1" className="po-title" />
          <Txt id="preorder.intro" as="p" className="po-intro" />
        </div>
        <Link to="#questions" className="po-help-link"><Txt id="preorder.how_it_works" /> <span aria-hidden="true">↓</span></Link>
      </header>
      <Timeline data={data} />
      <div className="po-order-notes">
        <span><Txt id={international ? 'preorder.terms_summary_international' : us ? 'preorder.terms_summary_us' : 'preorder.terms_summary'} /></span>
        <EarlyBirdNote show={!unavailable && rows.some((r) => r.early)} className="po-early-note" />
        {us ? (
          <InfoHint label={copyText('preorder.shipping_summary_us') ?? 'US orders'}>
            <Txt id="preorder.channel_us_text" as="p" />
          </InfoHint>
        ) : international ? (
          <InfoHint label={copyText('preorder.shipping_summary_international') ?? 'International orders'}>
            <Txt id="preorder.channel_international_text" as="p" />
          </InfoHint>
        ) : (
          <InfoHint label={copyText('preorder.shipping_summary') ?? 'EU orders'}>
            <Txt id="preorder.channel_eu_text" as="p" />
          </InfoHint>
        )}
        <Link to="/wholesale" className="po-trade-link">
          <Txt id="preorder.channel_trade" /> <span aria-hidden="true">→</span>
        </Link>
      </div>

      {unavailable ? (
        <Txt id="preorder.strip_unavailable" as="p" className="po-empty" />
      ) : !rows.length ? (
        // What's coming lives in the timeline above (dates per lane); this
        // does not repeat it, only the newsletter/browse follow-up.
        <section className="po-empty-state">
          <Txt id="preorder.tracker_empty" as="p" className="po-empty" />
          <div className="po-empty-actions">
            <NewsletterSignup
              variant="wide"
              titleId="preorder.empty_newsletter_title"
              turnstileSiteKey={rootData?.turnstileSiteKey ?? null}
              className="po-empty-newsletter"
            />
            <Link to="/products" className="od-btn od-btn-secondary po-empty-products">
              {copyText('chrome.nav_all_products') ?? 'All products'} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      ) : null}

      {!unavailable && stackRows.length ? (
        <section className="po-group" id="stack">
          <h2 className="po-group-title">
            <Txt id="preorder.stack_title" />
            {stackMonth ? <span className="po-group-meta">{shipWord('ships', stackWhen ?? stackMonth)}</span> : null}
          </h2>
          <Cards rows={stackRows} eta={eta} first />
        </section>
      ) : null}

      {!unavailable && targetRows.length ? (
        <section className="po-group" id="targets">
          <h2 className="po-group-title">
            <Txt id="preorder.targets_title" />
            <span className="po-group-meta">
              {`${shipWord('deadline', ends)}. ${(copyText('preorder.ship_eta_if_funded') ?? 'Ships by {date} if the target is reached').replace('{date}', eta)}`}
            </span>
          </h2>
          <Txt id="preorder.target_missed" as="p" className="po-group-line" />
          {stackMonth ? (
            <p className="po-group-line">
              {(copyText('preorder.targets_line') ?? '').replace('{month}', stackMonth)}
            </p>
          ) : null}
          {usBatchNote?.first ? (
            <p className="po-group-line">
              {(
                copyText(international ? 'preorder.international_batch_note' : 'preorder.us_batch_note') ??
                'FC and ESC batch 1 ({month}) is EU only. US orders ship from the {batch} batch.'
              )
                .replace('{month}', usBatchNote.first)
                .replace('{batch}', usBatchNote.batch)}
            </p>
          ) : null}
          <Cards rows={targetRows} eta={eta} />
        </section>
      ) : null}

      <section className="po-faq" id="questions">
        <Txt id="preorder.faq_title" as="h2" className="po-group-title" />
        {FAQ.map((key) => {
          const [q, a] = [`preorder.faq_q_${key}`, `preorder.faq_a_${key}`];
          return copyText(q) ? (
            <details className="po-faq-item" key={key}>
              <summary>
                <Txt id={q} />
              </summary>
              <Txt id={a} as="p" />
            </details>
          ) : null;
        })}
      </section>

      <nav
        className="po-channels"
        aria-label={copyText('preorder.channels_aria') ?? 'Retailers and launch news'}
      >
        <Link to="/wholesale"><Txt id="preorder.channel_us_cta" /> <span aria-hidden="true">↗</span></Link>
        <Link to="/newsletter"><Txt id="preorder.channel_interest" /> <span aria-hidden="true">→</span></Link>
      </nav>

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
      <ChatFpvWidget src={data.chatfpvWidget} />
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
      label: stackDay
        ? (copyText('preorder.timeline_targets') ?? 'RX, frames, motors')
        : (copyText('preorder.timeline_targets_us') ?? 'Every product'),
      events: [
        {day: endsDay, date: ends, what: copyText('preorder.timeline_deadline') ?? 'Deadline', kind: 'deadline'},
        {day: etaDay, date: eta, what: copyText('preorder.timeline_eta') ?? 'Ships if the target is reached', kind: 'eta'},
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

/** `first`: the section at the top of the page, whose first images are on
 *  screen at load and load at once, the first one with high priority. */
function Cards({rows, eta, first = false}: {rows: Row[]; eta: string; first?: boolean}) {
  return (
    <ul className="po-cards">
      {rows.map((row, i) => (
        <Card key={row.sku} row={row} eta={eta} eager={first && i < 4} lead={first && i === 0} />
      ))}
    </ul>
  );
}

function Card({row, eta, eager = false, lead = false}: {row: Row; eta: string; eager?: boolean; lead?: boolean}) {
  const name = row.variant ? `${row.product} ${row.variant}` : row.product;
  const cta = copyText('preorder.card_cta') ?? 'Pre-order';
  const currency = row.price.currencyCode;
  const bar = stepBarView(row.campaign, row.stepEnds);
  const funded = `${copyText('preorder.funded') ?? 'Target reached'}, ${shipWord('eta', shortCampaignDate(row.campaign.latestShip) ?? shipMonth(row.shipPromise) ?? eta)}`;
  return (
    <li className="po-card">
      <Link
        prefetch="intent"
        to={row.url}
        className={`po-card-media${row.image && row.render ? ' is-render' : ''}`}
        aria-hidden="true"
        tabIndex={-1}
      >
        {row.image && row.render ? (
          <span className="render-chip">{copyText('product-chrome.render_chip') ?? 'Render'}</span>
        ) : null}
        {row.image ? (
          <img
            src={shopifyImageUrl(row.image.url, 480)}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={lead ? 'high' : undefined}
            width={240}
            height={240}
          />
        ) : null}
      </Link>
      <h3 className="po-card-title">
        <Link prefetch="intent" to={row.url}>
          {row.product} {row.variant ? <span>{row.variant}</span> : null}
        </Link>
      </h3>
      <p className="po-card-price">
        {formatPrice(row.price.amount, currency)}
        {row.priceUnit ? <span> {row.priceUnit}</span> : null}
      </p>
      <StepBar bar={bar} fundedLabel={funded} batch={currentBatch(row.campaign) ? batchPhrase(currentBatch(row.campaign)!, preorderWords) : null} />
      <AddToCartButton
        className="po-card-cta"
        href={row.cartAddUrl}
        product={row.handle}
        revenue={{currency, amount: (Number(row.price.amount) || 0) * row.quantity}}
        ariaLabel={`${cta}: ${name}`}
      >
        {cta}
      </AddToCartButton>
    </li>
  );
}
