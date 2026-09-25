import {useEffect, useRef, useState} from 'react';
import {
  data,
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteLoaderData,
} from 'react-router';
import type {Route} from './+types/wholesale';
import {X} from 'lucide-react';
import type {RootLoader} from '~/root';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {legalHref} from '~/components/LangToggle';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {verifyTurnstile} from '~/lib/turnstile';
import {useTurnstile} from '~/lib/use-turnstile';
import {
  LEAD_SOURCES,
  MAX_LINES,
  MAX_QTY,
  SHOP_TYPES,
  TRADE_COUNTRIES,
  TRADE_GROUPS,
  TRADE_SKUS,
  VOLUME_BANDS,
  checkVies,
  sendTradeRequest,
  taxIdKind,
  tradeCountry,
  validateTradeRequest,
  type ShopType,
  type TradeField,
  type TradePrices,
  type TradeRequest,
} from '~/lib/trade';

/**
 * The trade page: a shop asks for a quote here instead of using the consumer
 * checkout, so it buys under Article 16 of the terms, not the consumer
 * contract. The form emails the company inbox; nothing touches the
 * Shopify cart. Words in `content/copy/wholesale.json`; what is sold, the
 * validation and the mail in `app/lib/trade.ts`.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('wholesale.meta_title') ?? 'Trade',
    description: copyText('wholesale.meta_description') ?? '',
  });

const t = (key: string, vars: Record<string, string> = {}) =>
  Object.entries(vars).reduce(
    (s, [k, v]) => s.replace(`{${k}}`, v),
    copyText(`wholesale.${key}`) ?? '',
  );

export async function loader({context}: Route.LoaderArgs) {
  const env = context.env as unknown as Record<string, string | undefined>;
  const company = getCompanyIdentity(env);
  // The catalog decides which allow-listed SKUs are offered; if it does not
  // answer, the whole allow-list is. Labels are the built-in ones, which
  // name sizes the Shopify titles leave out.
  let inCatalog: Set<string> | null = null;
  try {
    const catalog = await context.catalog.get();
    inCatalog = new Set(
      catalog.products.flatMap((p) => p.variants.map((v) => v.sku)),
    );
  } catch {
    inCatalog = null;
  }
  const products = TRADE_SKUS.filter(
    (s) => !inCatalog || inCatalog.has(s.sku),
  ).map((s) => ({
    sku: s.sku,
    label: s.label,
    group: s.group,
  }));
  return {email: company.email, products};
}

/** What the shop sent, echoed back on the page after a successful send.
 *  Nothing is mailed to the shop. */
type TradeSummary = Omit<TradeRequest, 'country' | 'vies'> & {
  countryName: string;
  taxKind: 'vat' | 'ein' | 'other';
};

type TradeResult = {
  ok: boolean;
  errors?: Partial<Record<TradeField, string>>;
  /** Why nothing reached the inbox. */
  failure?:
    | 'rejected'
    | 'rate_limited'
    | 'turnstile_failed'
    | 'not_configured'
    | 'not_sent';
  summary?: TradeSummary;
};

/** List prices by SKU from the catalog for the email, or null when the
 *  catalog does not answer. */
async function listPrices(
  context: Route.ActionArgs['context'],
): Promise<TradePrices | null> {
  try {
    const catalog = await context.catalog.get();
    const bySku: Record<string, number> = {};
    for (const p of catalog.products) {
      for (const v of p.variants) {
        const list = v.compare_price ?? v.price;
        if (v.sku && typeof list === 'number' && list > 0) bySku[v.sku] = list;
      }
    }
    return {
      currency: catalog.currency,
      includesVat: catalog.prices_include_vat,
      bySku,
    };
  } catch {
    return null;
  }
}

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<TradeResult>({ok: false, failure: 'rejected'}, {status: 405});
  }
  const env = context.env as unknown as Record<string, string | undefined>;
  const form = await request.formData();

  // Honeypot: hidden from people, so only a bot fills it. Rejected openly,
  // so a false positive is visible instead of a fake success.
  if (String(form.get('website') || '') !== '') {
    return data<TradeResult>({ok: false, failure: 'rejected'}, {status: 400});
  }
  const ip = clientIp(request);
  if (!checkRateLimit(`trade:${ip}`, 10, 60 * 60 * 1000).allowed) {
    return data<TradeResult>(
      {ok: false, failure: 'rate_limited'},
      {status: 429},
    );
  }

  const result = validateTradeRequest(form);
  if (!result.ok) {
    return data<TradeResult>({ok: false, errors: result.errors}, {status: 400});
  }
  // Turnstile after validation: a shop fixing a typo is not challenged
  // twice, and nothing is mailed without a human check.
  const human = await verifyTurnstile(
    context.env,
    String(form.get('cf-turnstile-response') ?? ''),
    ip,
  );
  if (!human.ok) {
    return data<TradeResult>(
      {ok: false, failure: 'turnstile_failed'},
      {status: 400},
    );
  }

  const req = result.request;
  const [vies, prices] = await Promise.all([
    taxIdKind(req.country) === 'vat'
      ? checkVies(req.taxId)
      : Promise.resolve(null),
    listPrices(context),
  ]);
  req.vies = vies;
  const {configured, sent} = await sendTradeRequest(
    env,
    req,
    fetch,
    prices,
  );
  if (!sent) {
    console.error('[trade] request not sent', {
      company: req.company,
      submittedAt: req.submittedAt,
    });
    return data<TradeResult>(
      {ok: false, failure: configured ? 'not_sent' : 'not_configured'},
      {status: 503},
    );
  }
  const {country, ...rest} = req;
  delete rest.vies;
  return data<TradeResult>({
    ok: true,
    summary: {...rest, countryName: country.name, taxKind: taxIdKind(country)},
  });
}

const field =
  'mt-1 mb-0! block w-full rounded-[var(--r-xs)] border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 font-sans text-[16px]! sm:text-[14px]! normal-case tracking-normal text-[var(--color-text)] aria-[invalid=true]:border-[var(--od-pcb-copper)]';
const labelCls =
  'block min-w-0 text-[12px] font-mono uppercase tracking-[0.12em] text-[var(--color-text-muted)]';
const legendCls =
  'mb-2.5 w-full border-t border-[var(--color-border)] pt-3 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-text)]';
const fieldsetCls = 'col-span-full m-0! block! min-w-0 border-0 p-0!';
const fieldGridCls =
  'grid min-w-0 grid-cols-2 gap-x-4 gap-y-2.5 max-sm:grid-cols-1';

function FieldError({msg}: {msg?: string}) {
  return msg ? (
    <span className="mt-1 block font-sans text-[12px] normal-case tracking-normal text-[var(--od-pcb-copper)]">
      {msg}
    </span>
  ) : null;
}

/** "(optional)" after a label, in the label's own muted case. */
function Optional() {
  return (
    <span className="normal-case tracking-normal"> ({t('optional')})</span>
  );
}

function Row({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-4 border-t border-[var(--color-border)] py-2 max-sm:grid-cols-1">
      <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-muted)] pt-[3px]">
        {label}
      </dt>
      <dd className="m-0 text-[14px] leading-[1.5] text-[var(--color-text)] whitespace-pre-line break-words">
        {children}
      </dd>
    </div>
  );
}

const taxLabelFor = (kind: 'vat' | 'ein' | 'other' | null) =>
  kind === 'ein'
    ? t('ein_label')
    : kind === 'vat'
      ? t('vat_label')
      : kind
        ? t('tax_other_label')
        : t('tax_label');

/** The on-page confirmation: what reached the inbox, as the shop typed it. */
function TradeSent({summary}: {summary: TradeSummary}) {
  const units = summary.lines.reduce((n, l) => n + l.qty, 0);
  const ref = useRef<HTMLDivElement>(null);
  // On a phone the form sits below the terms: bring the answer into view.
  useEffect(() => {
    ref.current?.scrollIntoView({block: 'start'});
  }, []);
  return (
    <div ref={ref} role="status" className="grid scroll-mt-24 gap-4">
      <div>
        <h2 className="font-mono text-[12px] uppercase tracking-[0.2em] text-[var(--color-text)]">
          {t('sent_title')}
        </h2>
        <p className="mt-1.5 text-[15px] leading-[1.5]">{t('sent')}</p>
      </div>
      <div>
        <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          {t('sent_summary')}
        </h3>
        <table className="mt-1.5 w-full border-collapse text-[14px]">
          <thead>
            <tr className="text-left font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-muted)]">
              <th className="py-1.5 pr-3 font-normal">{t('products')}</th>
              <th className="py-1.5 text-right font-normal">{t('qty')}</th>
            </tr>
          </thead>
          <tbody>
            {summary.lines.map((l) => (
              <tr key={l.sku} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-3">
                  {l.label}
                  <span className="ml-2 font-mono text-[11px] text-[var(--color-text-muted)]">
                    {l.sku}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{l.qty}</td>
              </tr>
            ))}
            <tr className="border-t border-[var(--color-border)] font-mono text-[12px] text-[var(--color-text-muted)]">
              <td className="py-1.5 pr-3">{t('sent_units')}</td>
              <td className="py-1.5 text-right tabular-nums">{units}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <dl className="m-0">
        <Row label={t('company')}>{summary.company}</Row>
        <Row label={t('contact_name')}>{summary.contactName}</Row>
        <Row label={t('email')}>{summary.email}</Row>
        <Row label={t('phone')}>{summary.phone}</Row>
        <Row label={t('site')}>{summary.website || '-'}</Row>
        <Row label={t('shop_type')}>{t(`shop_type_${summary.shopType}`)}</Row>
        <Row label={t('country')}>{summary.countryName}</Row>
        <Row label={taxLabelFor(summary.taxKind)}>{summary.taxId}</Row>
        <Row label={t('ship_to')}>{summary.shipTo}</Row>
        <Row label={t('bill_to')}>{summary.billTo ?? t('billing_same')}</Row>
        {summary.deliveryBy ? (
          <Row label={t('delivery_by')}>{summary.deliveryBy}</Row>
        ) : null}
        {summary.volume ? (
          <Row label={t('volume')}>
            {t(`volume_${summary.volume.replace('-', '_')}`)}
          </Row>
        ) : null}
        {summary.source ? (
          <Row label={t('source')}>{t(`source_${summary.source}`)}</Row>
        ) : null}
        {summary.note ? <Row label={t('note')}>{summary.note}</Row> : null}
      </dl>
      <p>
        <a href="/wholesale" className="od-btn od-btn-secondary od-btn-sm">
          {t('sent_again')}
        </a>
      </p>
    </div>
  );
}

let lineSeq = 1;

function TradeForm() {
  const {products, email} = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData<RootLoader>('root');
  const result = useActionData<TradeResult>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const [country, setCountry] = useState('');
  const [shopType, setShopType] = useState<ShopType | ''>('');
  const [billingSame, setBillingSame] = useState(true);
  const [lines, setLines] = useState<number[]>([0]);
  const [interacted, setInteracted] = useState(false);
  const siteKey = rootData?.turnstileSiteKey ?? null;
  const {containerRef, reset} = useTurnstile(siteKey, interacted);
  const errors = result?.errors ?? {};
  const formRef = useRef<HTMLFormElement>(null);

  // Every answer spends the Turnstile token; a rejected send moves focus to
  // the first marked field so the shop sees what to fix.
  useEffect(() => {
    if (!result) return;
    reset();
    if (!result.ok) {
      const first = formRef.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"]',
      );
      (first?.getAttribute('role') === 'radiogroup'
        ? first.querySelector<HTMLElement>('input')
        : first
      )?.focus();
    }
  }, [result, reset]);

  if (result?.ok && result.summary) {
    return <TradeSent summary={result.summary} />;
  }

  const chosen = tradeCountry(country);
  const taxKind = chosen ? taxIdKind(chosen) : null;
  const taxPlaceholder =
    taxKind === 'ein'
      ? '12-3456789'
      : taxKind === 'vat'
        ? `${chosen?.vatPrefix}…`
        : '';
  const failure = result?.failure;
  const [privacyBefore, privacyAfter] = t('privacy_note').split(
    t('privacy_link'),
  );

  return (
    <Form
      ref={formRef}
      method="post"
      className="grid grid-cols-2 gap-x-4 gap-y-3 max-sm:grid-cols-1"
      noValidate
      onFocus={() => setInteracted(true)}
    >
      <h2 className="col-span-full font-mono text-[12px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        {t('form_title')}
      </h2>
      {failure ? (
        <p
          role="alert"
          className="col-span-full text-[14px] text-[var(--od-pcb-copper)]"
        >
          {t(failure, {email})}
        </p>
      ) : Object.keys(errors).length ? (
        <p
          role="alert"
          className="col-span-full text-[14px] text-[var(--od-pcb-copper)]"
        >
          {t('check_fields')}
        </p>
      ) : null}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      <fieldset className={fieldsetCls}>
        <legend className={legendCls}>{t('section_company')}</legend>
        <div className={fieldGridCls}>
          <label className={labelCls}>
            {t('company')}
            <input
              name="company"
              required
              autoComplete="organization"
              className={field}
              aria-invalid={!!errors.company}
            />
            <FieldError msg={errors.company} />
          </label>
          <div
            role="radiogroup"
            aria-labelledby="trade-shop-type"
            aria-invalid={!!errors.shopType}
            className="min-w-0"
          >
            <span id="trade-shop-type" className={labelCls}>
              {t('shop_type')}
            </span>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {SHOP_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center justify-center rounded-[var(--r-xs)] border border-[var(--color-border)] px-2 py-1.5 text-center font-sans text-[13px] normal-case tracking-normal text-[var(--color-text-muted)] has-[:checked]:border-[var(--color-text)] has-[:checked]:text-[var(--color-text)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
                >
                  <input
                    type="radio"
                    name="shopType"
                    value={type}
                    checked={shopType === type}
                    onChange={() => setShopType(type)}
                    className="sr-only"
                  />
                  {t(`shop_type_${type}`)}
                </label>
              ))}
            </div>
            <FieldError msg={errors.shopType} />
          </div>
          <label className={labelCls}>
            {t('site')}
            {shopType === 'physical' ? <Optional /> : null}
            <input
              name="site"
              inputMode="url"
              autoComplete="url"
              placeholder={t('site_placeholder')}
              className={field}
              aria-invalid={!!errors.website}
            />
            <FieldError msg={errors.website} />
          </label>
          <label className={labelCls}>
            {t('country')}
            <select
              name="country"
              required
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className={field}
              aria-invalid={!!errors.country}
            >
              <option value="">{t('country_choose')}</option>
              {TRADE_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <FieldError msg={errors.country} />
          </label>
          <label className={labelCls}>
            {taxLabelFor(taxKind)}
            <input
              name="taxId"
              required
              placeholder={taxPlaceholder}
              className={field}
              aria-invalid={!!errors.taxId}
            />
            <FieldError msg={errors.taxId} />
          </label>
        </div>
      </fieldset>

      <fieldset className={fieldsetCls}>
        <legend className={legendCls}>{t('section_contact')}</legend>
        <div className={fieldGridCls}>
          <label className={labelCls}>
            {t('contact_name')}
            <input
              name="contactName"
              required
              autoComplete="name"
              className={field}
              aria-invalid={!!errors.contactName}
            />
            <FieldError msg={errors.contactName} />
          </label>
          <label className={labelCls}>
            {t('email')}
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className={field}
              aria-invalid={!!errors.email}
            />
            <FieldError msg={errors.email} />
          </label>
          <label className={labelCls}>
            {t('phone')}
            <input
              name="phone"
              type="tel"
              required
              autoComplete="tel"
              placeholder={t('phone_placeholder')}
              className={field}
              aria-invalid={!!errors.phone}
            />
            <FieldError msg={errors.phone} />
          </label>
        </div>
      </fieldset>

      <fieldset className={fieldsetCls}>
        <legend className={legendCls}>{t('section_products')}</legend>
        <div className={fieldGridCls}>
          <div
            role="group"
            aria-label={t('products')}
            className="col-span-full min-w-0"
          >
            <div className="grid gap-1.5">
              {lines.map((id, i) => (
                <div
                  key={id}
                  className="grid grid-cols-[minmax(0,1fr)_5rem_auto] gap-2"
                >
                  <select
                    name="sku"
                    defaultValue=""
                    aria-label={t('products')}
                    className={`${field} mt-0!`}
                    aria-invalid={!!errors.lines}
                  >
                    <option value="">{t('product_choose')}</option>
                    {TRADE_GROUPS.map((group) => {
                      const items = products.filter((p) => p.group === group);
                      return items.length ? (
                        <optgroup key={group} label={t(`group_${group}`)}>
                          {items.map((p) => (
                            <option key={p.sku} value={p.sku}>
                              {p.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </select>
                  <input
                    name="qty"
                    type="number"
                    min={1}
                    max={MAX_QTY}
                    step={1}
                    inputMode="numeric"
                    aria-label={t('qty')}
                    placeholder={t('qty')}
                    className={`${field} mt-0!`}
                    aria-invalid={!!errors.lines}
                  />
                  <button
                    type="button"
                    className="od-btn od-btn-ghost od-btn-sm px-2!"
                    disabled={lines.length === 1}
                    aria-label={t('remove')}
                    title={t('remove')}
                    onClick={() =>
                      setLines((ls) => ls.filter((_, j) => j !== i))
                    }
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            <FieldError msg={errors.lines} />
            {lines.length < MAX_LINES ? (
              <button
                type="button"
                className="od-btn od-btn-secondary od-btn-sm mt-1.5"
                onClick={() => setLines((ls) => [...ls, lineSeq++])}
              >
                {t('add_line')}
              </button>
            ) : null}
          </div>
        </div>
      </fieldset>

      <fieldset className={fieldsetCls}>
        <legend className={legendCls}>{t('section_delivery')}</legend>
        <div className={fieldGridCls}>
          <label className={labelCls}>
            {t('ship_to')}
            <textarea
              name="shipTo"
              required
              rows={3}
              autoComplete="shipping street-address"
              placeholder={t('address_placeholder')}
              className={field}
              aria-invalid={!!errors.shipTo}
            />
            <FieldError msg={errors.shipTo} />
          </label>
          <div className="grid min-w-0 content-start gap-2.5">
            <label className={labelCls}>
              {t('delivery_by')}
              <Optional />
              <input
                name="deliveryBy"
                type="date"
                className={field}
                aria-invalid={!!errors.deliveryBy}
              />
              <FieldError msg={errors.deliveryBy} />
            </label>
            <label className="flex items-start gap-2 text-[14px] text-[var(--color-text)]">
              <input
                type="checkbox"
                name="billingSame"
                checked={billingSame}
                onChange={(e) => setBillingSame(e.target.checked)}
                className="mt-[3px]"
              />
              {t('billing_same')}
            </label>
          </div>
          {billingSame ? null : (
            <label className={labelCls}>
              {t('bill_to')}
              <textarea
                name="billTo"
                required
                rows={3}
                autoComplete="billing street-address"
                placeholder={t('address_placeholder')}
                className={field}
                aria-invalid={!!errors.billTo}
              />
              <FieldError msg={errors.billTo} />
            </label>
          )}
        </div>
      </fieldset>

      <fieldset className={fieldsetCls}>
        <legend className={legendCls}>
          {t('section_more')}
          <span className="normal-case tracking-normal text-[var(--color-text-muted)]">
            {' '}
            ({t('optional')})
          </span>
        </legend>
        <div className={fieldGridCls}>
          <label className={labelCls}>
            {t('volume')}
            <select
              name="volume"
              defaultValue=""
              className={field}
              aria-invalid={!!errors.volume}
            >
              <option value="">{t('choose')}</option>
              {VOLUME_BANDS.map((v) => (
                <option key={v} value={v}>
                  {t(`volume_${v.replace('-', '_')}`)}
                </option>
              ))}
            </select>
            <FieldError msg={errors.volume} />
          </label>
          <label className={labelCls}>
            {t('source')}
            <select
              name="source"
              defaultValue=""
              className={field}
              aria-invalid={!!errors.source}
            >
              <option value="">{t('choose')}</option>
              {LEAD_SOURCES.map((v) => (
                <option key={v} value={v}>
                  {t(`source_${v}`)}
                </option>
              ))}
            </select>
            <FieldError msg={errors.source} />
          </label>
          <label className={`${labelCls} col-span-full`}>
            {t('note')}
            <textarea
              name="note"
              rows={3}
              placeholder={t('note_placeholder')}
              className={field}
            />
          </label>
        </div>
      </fieldset>

      {siteKey && interacted ? (
        <div ref={containerRef} className="col-span-full" />
      ) : null}

      <div className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        <button type="submit" disabled={busy} className="od-btn od-btn-primary">
          {busy ? t('submitting') : t('submit')}
        </button>
        <p className="m-0 text-[12px] text-[var(--color-text-muted)]">
          {privacyBefore}
          <Link
            to="/privacy"
            className="underline underline-offset-2"
            style={{textDecoration: 'underline'}}
          >
            {t('privacy_link')}
          </Link>
          {privacyAfter}
        </p>
      </div>
    </Form>
  );
}

export default function WholesaleRoute() {
  const [before, after] = t('lead').split(t('lead_link'));
  const contractLink = t('contract_link');
  const [contractBefore, contractAfter] = t('contract').split(contractLink);

  return (
    <div className="page-shell">
      <div className="grid gap-x-14 gap-y-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div>
          <header className="page-header">
            <h1 className="page-title">{t('title')}</h1>
            <p className="page-description">
              {before}
              <Link
                to="/products"
                className="underline underline-offset-2"
                style={{textDecoration: 'underline'}}
              >
                {t('lead_link')}
              </Link>
              {after}
            </p>
            <a
              href="#request"
              className="mt-3 inline-block font-mono text-[12px] uppercase tracking-[0.15em] underline underline-offset-4 lg:hidden"
            >
              {t('jump_to_form')} <span aria-hidden="true">↓</span>
            </a>
          </header>
          <dl aria-label={t('terms_title')} className="m-0">
            <Row label={t('row_price')}>{t('price')}</Row>
            <Row label={t('row_vat')}>{t('vat')}</Row>
            <Row label={t('row_export')}>{t('export')}</Row>
            <Row label={t('row_sold')}>{t('sold')}</Row>
            <Row label={t('row_minimum')}>{t('minimum')}</Row>
            <Row label={t('row_lead')}>{t('timing')}</Row>
            <Row label={t('row_payment')}>{t('payment')}</Row>
            <Row label={t('row_contract')}>
              {contractBefore}
              <Link
                to={`${legalHref('/algemene-voorwaarden', 'en')}#art-16`}
                className="underline underline-offset-2"
                style={{textDecoration: 'underline'}}
              >
                {contractLink}
              </Link>
              {contractAfter}
            </Row>
          </dl>
        </div>
        <div id="request" className="scroll-mt-24 lg:pt-2">
          <TradeForm />
        </div>
      </div>
    </div>
  );
}
