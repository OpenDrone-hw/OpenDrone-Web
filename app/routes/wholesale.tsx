import {useState} from 'react';
import {data, Form, Link, useActionData, useLoaderData, useNavigation} from 'react-router';
import type {Route} from './+types/wholesale';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {legalHref} from '~/components/LangToggle';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {
  MAX_LINES,
  MAX_QTY,
  TRADE_COUNTRIES,
  TRADE_GROUPS,
  TRADE_SKUS,
  sendTradeRequest,
  taxIdKind,
  tradeCountry,
  validateTradeRequest,
  type TradeField,
  type TradeGroup,
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
    inCatalog = new Set(catalog.products.flatMap((p) => p.variants.map((v) => v.sku)));
  } catch {
    inCatalog = null;
  }
  const products = TRADE_SKUS.filter((s) => !inCatalog || inCatalog.has(s.sku)).map((s) => ({
    sku: s.sku,
    label: s.label,
    group: s.group,
  }));
  return {email: company.email, products};
}

type TradeResult = {
  ok: boolean;
  errors?: Partial<Record<TradeField, string>>;
  /** Why nothing reached the inbox. */
  failure?: 'rejected' | 'rate_limited' | 'not_configured' | 'not_sent';
};

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
    return data<TradeResult>({ok: false, failure: 'rate_limited'}, {status: 429});
  }

  const result = validateTradeRequest(form);
  if (!result.ok) {
    return data<TradeResult>({ok: false, errors: result.errors}, {status: 400});
  }
  const {configured, sent} = await sendTradeRequest(env, result.request);
  if (!sent) {
    console.error('[trade] request not sent', {
      shop: result.request.shop,
      submittedAt: result.request.submittedAt,
    });
    return data<TradeResult>(
      {ok: false, failure: configured ? 'not_sent' : 'not_configured'},
      {status: 503},
    );
  }
  return data<TradeResult>({ok: true});
}

const field =
  'mt-1 mb-0! block w-full rounded-[var(--r-xs)] border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 font-sans text-[16px]! sm:text-[14px]! normal-case tracking-normal text-[var(--color-text)] aria-[invalid=true]:border-[var(--od-pcb-copper)]';
const labelCls = 'block text-[12px] font-mono uppercase tracking-[0.12em] text-[var(--color-text-muted)]';

function FieldError({msg}: {msg?: string}) {
  return msg ? (
    <span className="mt-1 block font-sans text-[12px] normal-case tracking-normal text-[var(--od-pcb-copper)]">{msg}</span>
  ) : null;
}

function Row({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-x-4 border-t border-[var(--color-border)] py-2 max-sm:grid-cols-1">
      <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-muted)] pt-[3px]">{label}</dt>
      <dd className="m-0 text-[14px] leading-[1.5] text-[var(--color-text)]">{children}</dd>
    </div>
  );
}

let lineSeq = 1;

function TradeForm() {
  const {products, email} = useLoaderData<typeof loader>();
  const result = useActionData<TradeResult>();
  const nav = useNavigation();
  const busy = nav.state !== 'idle';
  const [country, setCountry] = useState('');
  const [lines, setLines] = useState<number[]>([0]);
  const errors = result?.errors ?? {};

  if (result?.ok) {
    return (
      <div className="rounded-[var(--r-xs)] border border-[var(--color-border)] p-6" role="status">
        <p className="text-[16px]">{t('sent')}</p>
      </div>
    );
  }

  const chosen = tradeCountry(country);
  const taxKind = chosen ? taxIdKind(chosen) : null;
  const taxLabel =
    taxKind === 'ein' ? t('ein_label') : taxKind === 'vat' ? t('vat_label') : taxKind ? t('tax_other_label') : t('tax_label');
  const taxPlaceholder = taxKind === 'ein' ? '12-3456789' : taxKind === 'vat' ? `${chosen?.vatPrefix}…` : '';
  const failure = result?.failure;

  return (
    <Form method="post" className="grid grid-cols-2 gap-x-4 gap-y-2.5 max-sm:grid-cols-1" noValidate>
      <h2 className="col-span-full font-mono text-[12px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
        {t('form_title')}
      </h2>
      {failure ? (
        <p role="alert" className="col-span-full text-[14px] text-[var(--od-pcb-copper)]">
          {t(failure, {email})}
        </p>
      ) : Object.keys(errors).length ? (
        <p role="alert" className="col-span-full text-[14px] text-[var(--od-pcb-copper)]">
          {t('check_fields')}
        </p>
      ) : null}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />

      <label className={labelCls}>
        {t('shop')}
        <input name="shop" required autoComplete="organization" className={field} aria-invalid={!!errors.shop} />
        <FieldError msg={errors.shop} />
      </label>
      <label className={labelCls}>
        {t('site')}
        <input name="site" required inputMode="url" autoComplete="url" placeholder={t('site_placeholder')} className={field} aria-invalid={!!errors.website} />
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
        {taxLabel}
        <input name="taxId" required placeholder={taxPlaceholder} className={field} aria-invalid={!!errors.taxId} />
        <FieldError msg={errors.taxId} />
      </label>
      <label className={labelCls}>
        {t('contact_name')}
        <input name="contactName" required autoComplete="name" className={field} aria-invalid={!!errors.contactName} />
        <FieldError msg={errors.contactName} />
      </label>
      <label className={labelCls}>
        {t('email')}
        <input name="email" type="email" required autoComplete="email" className={field} aria-invalid={!!errors.email} />
        <FieldError msg={errors.email} />
      </label>

      <div role="group" aria-labelledby="trade-products" className="col-span-full min-w-0">
        <span id="trade-products" className={labelCls}>{t('products')}</span>
        <div className="mt-1 grid gap-1.5">
          {lines.map((id, i) => (
            <div key={id} className="grid grid-cols-[1fr_5.5rem_auto] gap-2">
              <select name="sku" defaultValue="" aria-label={t('products')} className={`${field} mt-0!`} aria-invalid={!!errors.lines}>
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
                className="od-btn od-btn-ghost od-btn-sm"
                disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
              >
                {t('remove')}
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

      <label className={labelCls}>
        {t('ship_to')}
        <textarea name="shipTo" required rows={3} autoComplete="shipping street-address" className={field} aria-invalid={!!errors.shipTo} />
        <FieldError msg={errors.shipTo} />
      </label>
      <label className={labelCls}>
        {t('note')}
        <textarea name="note" rows={3} className={field} />
      </label>

      <div className="col-span-full pt-1">
        <button type="submit" disabled={busy} className="od-btn od-btn-primary">
          {busy ? t('submitting') : t('submit')}
        </button>
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
              <Link to="/products" className="underline underline-offset-2" style={{textDecoration: 'underline'}}>
                {t('lead_link')}
              </Link>
              {after}
            </p>
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
                className="underline underline-offset-2" style={{textDecoration: 'underline'}}
              >
                {contractLink}
              </Link>
              {contractAfter}
            </Row>
          </dl>
        </div>
        <div className="lg:pt-2">
          <TradeForm />
        </div>
      </div>
    </div>
  );
}
