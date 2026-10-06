import {useEffect, useRef, useState} from 'react';
import {data, Form, Link, useActionData, useLoaderData, useNavigation, useRouteLoaderData} from 'react-router';
import {Check, ArrowUpRight, ChevronDown} from 'lucide-react';
import type {Route} from './+types/wholesale';
import type {RootLoader} from '~/root';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {verifyTurnstile} from '~/lib/turnstile';
import {useTurnstile} from '~/lib/use-turnstile';
import {sameOrigin} from '~/lib/accounts/config';
import {TRADE_COUNTRIES, submitTradeApplication, tradeConfigured, validateTradeApplication, type TradeField} from '~/lib/trade';

const t = (key: string) => copyText(`wholesale.${key}`) ?? '';
export const meta: Route.MetaFunction = () => buildSeoMeta({title: t('meta_title'), description: t('meta_description'), canonical: `${SITE_ORIGIN}/wholesale`});

// Form results contain personal details; never let an edge cache retain them.
export const headers: Route.HeadersFunction = () => ({'Cache-Control': 'private, no-store'});
export async function loader({context}: Route.LoaderArgs) {
  return {email: getCompanyIdentity(context.env as unknown as Record<string, string | undefined>).email, ready: tradeConfigured(context.env)};
}

type TradeResult = {
  ok: boolean;
  errors?: Partial<Record<TradeField, string>>;
  failure?: 'rejected' | 'rate_limited' | 'turnstile_failed' | 'not_configured' | 'unavailable';
};

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST' || !sameOrigin(request)) return data<TradeResult>({ok: false, failure: 'rejected'}, {status: 403});
  const form = await request.formData();
  if (String(form.get('website') || '')) return data<TradeResult>({ok: false, failure: 'rejected'}, {status: 400});
  const ip = clientIp(request);
  if (!checkRateLimit(`trade:${ip}`, 5, 60 * 60 * 1000).allowed) return data<TradeResult>({ok: false, failure: 'rate_limited'}, {status: 429});
  const valid = validateTradeApplication(form);
  if (!valid.ok) return data<TradeResult>({ok: false, errors: valid.errors}, {status: 400});
  const human = await verifyTurnstile(context.env, String(form.get('cf-turnstile-response') ?? ''), ip);
  if (!human.ok) return data<TradeResult>({ok: false, failure: 'turnstile_failed'}, {status: 400});
  // Local development never mails the company inbox.
  if (import.meta.env.DEV) return data<TradeResult>({ok: false, failure: 'not_configured'}, {status: 503});
  const result = await submitTradeApplication(context.env, valid.application);
  if (!result.ok) return data<TradeResult>({ok: false, failure: result.reason}, {status: 503});
  return data<TradeResult>({ok: true});
}

const field = 'mt-2 block w-full rounded-[var(--r-xs)] border border-[var(--color-border)] bg-transparent px-3 py-2.5 font-sans text-[16px] normal-case tracking-normal text-[var(--color-text)] focus:border-[var(--color-text)] aria-[invalid=true]:border-[var(--od-pcb-copper)]';
const label = 'block min-w-0 font-sans text-[13px] text-[var(--color-text-muted)]';

function FieldError({message, id}: {message?: string; id: string}) {
  return message ? <span id={id} className="mt-1 block text-[12px] text-[var(--od-pcb-copper)]">{message}</span> : null;
}

function ApplicationForm() {
  const {email, ready} = useLoaderData<typeof loader>();
  const rootData = useRouteLoaderData<RootLoader>('root');
  const result = useActionData<TradeResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const [interacted, setInteracted] = useState(false);
  const {containerRef, reset} = useTurnstile(rootData?.turnstileSiteKey ?? null, interacted);
  const formRef = useRef<HTMLFormElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const errors = result?.errors ?? {};
  useEffect(() => {
    if (!result) return;
    reset();
    if (result.ok) successRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [result, reset]);

  if (result?.ok) return (
    <div ref={successRef} tabIndex={-1} role="status" className="border-t border-[var(--color-border)] py-8 outline-none">
      <Check size={22} className="mb-4" aria-hidden="true" />
      <h2 className="m-0 text-xl font-medium">{t('sent_title')}</h2>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-[var(--color-text-muted)]">{t('sent')}</p>
      <Link to="/products" className="mt-4 inline-flex items-center gap-2 text-[13px] underline underline-offset-4">{t('browse')} <ArrowUpRight size={14} aria-hidden="true" /></Link>
    </div>
  );

  return (
    <Form ref={formRef} method="post" className="grid gap-5" onFocus={() => setInteracted(true)}>
      {result?.failure ? <p role="alert" className="m-0 text-sm text-[var(--od-pcb-copper)]">{t(result.failure)} <a href={`mailto:${email}`} className="underline">{email}</a></p> : null}
      {Object.keys(errors).length ? <p role="alert" className="m-0 text-sm text-[var(--od-pcb-copper)]">{t('check_fields')}</p> : null}
      {!ready ? <p className="m-0 text-sm text-[var(--color-text-muted)]">{t('offline')} <a href={`mailto:${email}`} className="underline">{email}</a>.</p> : null}
      <div className="hidden" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <label className={label}>{t('company')}
        <input name="company" required maxLength={200} autoComplete="organization" className={field} aria-invalid={!!errors.company} aria-describedby={errors.company ? 'company-error' : undefined} />
        <FieldError id="company-error" message={errors.company} />
      </label>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className={label}>{t('contact_name')}
          <input name="contactName" required maxLength={100} autoComplete="name" className={field} aria-invalid={!!errors.contactName} aria-describedby={errors.contactName ? 'name-error' : undefined} />
          <FieldError id="name-error" message={errors.contactName} />
        </label>
        <label className={label}>{t('email')}
          <input name="email" type="email" required maxLength={254} autoComplete="email" className={field} aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-error' : undefined} />
          <FieldError id="email-error" message={errors.email} />
        </label>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className={label}>{t('country')}
          <select name="country" required defaultValue="" autoComplete="country" className={field} aria-invalid={!!errors.country} aria-describedby={errors.country ? 'country-error' : undefined}>
            <option value="" disabled>{t('country_choose')}</option>
            {TRADE_COUNTRIES.map(country => <option key={country.code} value={country.code}>{country.name}</option>)}
          </select>
          <FieldError id="country-error" message={errors.country} />
        </label>
        <label className={label}>{t('site')} <span className="text-[11px] opacity-70">{t('optional')}</span>
          <input name="site" maxLength={300} inputMode="url" autoComplete="url" placeholder="yourshop.com" className={field} aria-invalid={!!errors.website} aria-describedby={errors.website ? 'site-error' : undefined} />
          <FieldError id="site-error" message={errors.website} />
        </label>
      </div>
      <details open={!!errors.note} className="group">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 text-[13px] text-[var(--color-text-muted)] [&::-webkit-details-marker]:hidden">{t('note_toggle')} <ChevronDown size={14} className="group-open:rotate-180" aria-hidden="true" /></summary>
        <label className={`${label} mt-3`}>{t('note')}
          <textarea name="note" rows={3} maxLength={2000} placeholder={t('note_placeholder')} className={field} aria-invalid={!!errors.note} aria-describedby={errors.note ? 'note-error' : undefined} />
          <FieldError id="note-error" message={errors.note} />
        </label>
      </details>
      {rootData?.turnstileSiteKey && interacted ? <div ref={containerRef} /> : null}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
        <button type="submit" disabled={busy || !ready} className="od-btn od-btn-primary">{busy ? t('submitting') : t('submit')} <ArrowUpRight size={15} aria-hidden="true" /></button>
        <span className="text-[12px] text-[var(--color-text-muted)]">{t('no_obligation')}</span>
      </div>
      <p className="wholesale-privacy text-[var(--color-text-muted)]">{t('privacy_note')} <Link to="/privacy" className="underline underline-offset-2">{t('privacy_link')}</Link>.</p>
    </Form>
  );
}

export default function WholesaleRoute() {
  const {email} = useLoaderData<typeof loader>();
  return (
    <div className="page-shell wholesale-page">
      <div className="mx-auto max-w-[560px] pb-6 sm:pb-12">
        <header className="mb-8 sm:mb-10">
          <h1 className="page-title">{t('title')}</h1>
          <p className="wholesale-lead max-w-md text-[var(--color-text-muted)]">{t('lead')}</p>
        </header>
        <ApplicationForm />
        <p className="wholesale-contact text-[var(--color-text-muted)]">{t('contact_lead')} <a href={`mailto:${email}`} className="text-[var(--color-text)] underline underline-offset-4">{email}</a></p>
      </div>
    </div>
  );
}
