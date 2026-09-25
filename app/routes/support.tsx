import {useEffect, useRef, useState, type FormEvent} from 'react';
import {data, Form, Link, redirect, useActionData, useLoaderData, useNavigate, useRouteLoaderData} from 'react-router';
import type {Route} from './+types/support';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {legalHref} from '~/components/LangToggle';
import {Txt} from '~/components/Txt';
import {
  FilePicker,
  fill,
  guardSubmit,
  usePost,
  MessageBox,
  SupportError,
  TicketList,
  TurnstileBox,
  useDraft,
} from '~/components/SupportUi';
import {handleCreate, type CreateResult} from '~/lib/support/handlers';
import {notifyEnabled} from '~/lib/support/notify';
import {originOf, supportDeps, supportReady, supportHeaders} from '~/lib/support/server';
import {publicTicket, type FieldError, type NewTicketInput} from '~/lib/support/tickets';
import type {FileProblem} from '~/lib/support/uploads';
import {readTicketCookie} from '~/lib/support/tokens';
import {TOPIC_FIELDS, TOPICS, type TicketTopic} from '~/lib/support/form';

/**
 * The support front door: pick a topic, fill in the few fields it needs,
 * and the ticket opens in the team's Discord. The customer lands on the
 * ticket page (support_.t.$ref.tsx). Tickets this browser opened are
 * listed; a lost link is recovered at /support/find. Email is offered for
 * sales only. Words in content/copy/support.json; rules in
 * app/lib/support/tickets.ts.
 */
/** Private, never cached, never indexed; keeps loader and action headers. */
export const headers = supportHeaders;

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('support.meta_title') ?? 'Support',
    description: copyText('support.meta_description') ?? '',
  });

const t = (key: string, vars: Record<string, string> = {}) => fill(copyText(`support.${key}`), vars);

const HELP_LINKS: Array<{to: string; key: string}> = [
  {to: '/preorder#questions', key: 'topic_preorder'},
  {to: '/shipping', key: 'topic_shipping'},
  {to: '/herroepingsrecht', key: 'topic_returns'},
  {to: '/warranty', key: 'topic_warranty'},
  {to: '/algemene-voorwaarden', key: 'topic_terms'},
];

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  const company = getCompanyIdentity(env as unknown as Record<string, string | undefined>);
  const ready = supportReady(env);
  const topic = new URL(request.url).searchParams.get('topic');

  let products: string[] = [];
  try {
    const catalog = await context.catalog.get();
    products = [...new Set(catalog.products.map((p) => p.title).filter(Boolean))].sort();
  } catch {
    products = [];
  }

  let yours: ReturnType<typeof publicTicket>[] = [];
  if (ready) {
    try {
      const deps = supportDeps(env, originOf(request));
      const cookie = await readTicketCookie(env, request);
      const found = await deps.store.ticketsByRefs(cookie.map((c) => c.r));
      yours = cookie
        .map((c) => found.find((f) => f.ref === c.r && f.linkVersion === c.k))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .map(publicTicket);
    } catch {
      yours = [];
    }
  }

  return data(
    {
      ready,
      notify: notifyEnabled(env),
      products,
      yours,
      initialTopic: TOPICS.includes(topic as TicketTopic) ? (topic as TicketTopic) : null,
      salesEmail: company.email,
      discordInvite: env.DISCORD_SUPPORT_INVITE ?? env.PUBLIC_DISCORD_INVITE ?? 'https://discord.gg/ABajnacUsS',
    },
    {headers: {'Cache-Control': 'private, no-store'}},
  );
}

type ActionResult = CreateResult;

export async function action({request, context}: Route.ActionArgs) {
  const o = await handleCreate(request, context);
  if (o.body.ok) return redirect(o.body.url, {headers: o.cookie ? {'Set-Cookie': o.cookie} : {}});
  return data<ActionResult>(o.body, {status: o.status});
}

function FieldError({error, field}: {error?: FieldError; field: string}) {
  if (!error) return null;
  const key =
    error === 'invalid' ? (field === 'email' ? 'err_invalid_email' : 'err_invalid_order') : `err_${error}`;
  return (
    <span className="sp-field-error" id={`sp-${field}-error`}>
      {t(key)}
    </span>
  );
}

function TicketForm() {
  const {products, notify, initialTopic} = useLoaderData<typeof loader>();
  const root = useRouteLoaderData('root') as {turnstileSiteKey?: string | null} | undefined;
  // Without JavaScript the page's action answers; with it, the fetch below.
  const actionResult = useActionData<ActionResult>();
  const [fetched, setFetched] = useState<ActionResult | null>(null);
  const result = fetched ?? actionResult;
  const {busy, sendingFiles, post} = usePost<ActionResult>();
  const navigate = useNavigate();
  const [topic, setTopic] = useState<TicketTopic | null>(initialTopic);
  const [touched, setTouched] = useState(false);
  const [clientProblem, setClientProblem] = useState<string | null>(null);
  // The banner of an answer goes once the files change: it may no longer apply.
  const [bannerDismissed, setBannerDismissed] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLParagraphElement>(null);
  useDraft(formRef, 'new', initialTopic ? ['topic'] : []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    const problem = guardSubmit(event);
    setClientProblem(problem);
    if (problem) return;
    event.preventDefault();
    const form = event.currentTarget;
    const body = await post('/api/support/new', form);
    if (body?.ok) {
      void navigate(body.url);
      return;
    }
    // No answer at all: the connection dropped. Everything typed and chosen stays.
    setFetched(body ?? {ok: false, failure: 'send', at: Date.now()});
  }

  // A field's error clears once it is edited after this answer; the next
  // submit decides again. Tied to the answer, so a new answer starts clean
  // in the same render (the focus below then finds the invalid field).
  const [edited, setEdited] = useState<{at: number; names: Set<string>}>({at: 0, names: new Set()});
  const editedNow = edited.at === result?.at ? edited.names : new Set<string>();
  const errors = Object.fromEntries(
    Object.entries((result && !result.ok ? result.errors : undefined) ?? {}).filter(([k]) => !editedNow.has(k === 'orderNumber' ? 'order' : k)),
  ) as NonNullable<Extract<ActionResult, {ok: false}>['errors']>;
  const fields = topic ? TOPIC_FIELDS[topic] : null;

  function choose(next: TicketTopic) {
    const first = topic === null;
    setTopic(next);
    setTouched(true);
    if (first) window.setTimeout(() => detailsRef.current?.scrollIntoView({behavior: 'smooth', block: 'start'}), 60);
  }

  // After an answer: move to the first invalid field, else to the message.
  useEffect(() => {
    if (!result) return;
    const target =
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? bannerRef.current ?? null;
    target?.scrollIntoView({block: 'center', behavior: 'smooth'});
    target?.focus({preventScroll: true});
  }, [result?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = result && !result.ok ? result : null;
  const failure = failed?.failure;
  const invalid = (k: keyof NewTicketInput) => (errors[k] ? {'aria-invalid': true, 'aria-describedby': `sp-${k}-error`} : {});
  const answerBanner =
    !failed || bannerDismissed === failed.at
      ? null
      : failure
        ? failure === 'files'
          ? t(`file_${failed.file?.problem ?? ('type' satisfies FileProblem)}`, {file: failed.file?.name ?? ''})
          : t(`err_${failure}`)
        : Object.keys(errors).length
          ? t('err_check')
          : null;
  const bannerText = clientProblem ?? answerBanner;

  return (
    <Form
      ref={formRef}
      method="post"
      encType="multipart/form-data"
      className="sp-form"
      noValidate
      onFocus={() => setTouched(true)}
      onSubmit={(e) => void submit(e)}
      onInput={(e) => {
        const name = (e.target as HTMLInputElement).name;
        if (!name || !result) return;
        setEdited((cur) => {
          const names = new Set(cur.at === result.at ? cur.names : []);
          names.add(name);
          return {at: result.at, names};
        });
      }}
    >
      <fieldset className="sp-topics">
        <legend className="sp-step">
          <span className="sp-step-num">1</span>
          {t('step_topic')}
        </legend>
        <div className="sp-topic-grid">
          {TOPICS.map((key) => (
            <label key={key} className={`sp-topic${topic === key ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="topic"
                value={key}
                checked={topic === key}
                onChange={() => choose(key)}
                className="sp-visually-hidden"
              />
              <span className="sp-topic-title">{t(`topic_${key}_title`)}</span>
              <span className="sp-topic-hint">{t(`topic_${key}_hint`)}</span>
            </label>
          ))}
        </div>
        {errors.topic ? <span className="sp-field-error">{t('err_required')}</span> : null}
      </fieldset>

      {topic && fields ? (
        <div className="sp-details" ref={detailsRef}>
          <h2 className="sp-step">
            <span className="sp-step-num">2</span>
            {t('step_details')}
          </h2>

          {bannerText ? (
            <p ref={bannerRef} role="alert" tabIndex={-1} className="sp-banner sp-banner-error">
              {bannerText}
            </p>
          ) : null}

          <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="sp-honeypot" />

          <div className="sp-row">
            <label className="sp-field">
              <span className="sp-label">{t('field_name')}</span>
              <input name="name" autoComplete="name" maxLength={80} required className="sp-input" {...invalid('name')} />
              <FieldError error={errors.name} field="name" />
            </label>
            <div className="sp-field">
              <label className="sp-label" htmlFor="sp-email">
                {t('field_email')}
              </label>
              <input
                id="sp-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                className="sp-input"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={[errors.email ? 'sp-email-error' : '', 'sp-email-hint'].filter(Boolean).join(' ')}
              />
              <FieldError error={errors.email} field="email" />
              <span id="sp-email-hint" className="sp-hint">
                {t(notify ? 'email_hint_notify' : 'email_hint')}
              </span>
            </div>
          </div>

          {fields.order || fields.product ? (
            <div className="sp-row">
              {fields.order ? (
                <div className="sp-field">
                  <label className="sp-label" htmlFor="sp-order">
                    {t('field_order')}
                    {fields.order === 'optional' ? <span className="sp-optional"> ({t('optional')})</span> : null}
                  </label>
                  <input
                    id="sp-order"
                    name="order"
                    inputMode="numeric"
                    placeholder="#1042"
                    maxLength={20}
                    required={fields.order === 'required'}
                    className="sp-input"
                    aria-invalid={errors.orderNumber ? true : undefined}
                    aria-describedby={[errors.orderNumber ? 'sp-orderNumber-error' : '', 'sp-order-hint'].filter(Boolean).join(' ')}
                  />
                  <FieldError error={errors.orderNumber} field="orderNumber" />
                  <span id="sp-order-hint" className="sp-hint">
                    {t('order_hint')}
                  </span>
                </div>
              ) : null}
              {fields.product ? (
                <label className="sp-field">
                  <span className="sp-label">{t('field_product')}</span>
                  {products.length ? (
                    <select name="product" defaultValue="" required className="sp-input" {...invalid('product')}>
                      <option value="" disabled>
                        {t('product_choose')}
                      </option>
                      {products.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                      <option value="Other">{t('product_other')}</option>
                    </select>
                  ) : (
                    <input name="product" maxLength={80} required className="sp-input" {...invalid('product')} />
                  )}
                  <FieldError error={errors.product} field="product" />
                </label>
              ) : null}
            </div>
          ) : null}

          {fields.firmware ? (
            <label className="sp-field sp-field-half">
              <span className="sp-label">
                {t('field_firmware')}
                <span className="sp-optional"> ({t('optional')})</span>
              </span>
              <input name="firmware" maxLength={60} placeholder={t('firmware_placeholder')} className="sp-input" />
            </label>
          ) : null}

          <div>
            <MessageBox
              label={t('field_message')}
              placeholder={t(`message_placeholder_${topic}`)}
              invalid={Boolean(errors.message)}
              describedBy={errors.message ? 'sp-message-error' : undefined}
            />
            <FieldError error={errors.message} field="message" />
          </div>

          <div className="sp-field">
            <span className="sp-label">
              {t('field_files')}
              <span className="sp-optional"> ({t('optional')})</span>
            </span>
            <FilePicker
              disabled={busy}
              onChange={() => {
                setClientProblem(null);
                if (result) setBannerDismissed(result.at);
              }}
            />
          </div>

          <TurnstileBox siteKey={root?.turnstileSiteKey ?? null} active={touched} resetKey={result?.at} />

          <div className="sp-submit-row">
            <button type="submit" className="od-btn od-btn-primary" disabled={busy}>
              {busy ? t('submitting') : t('submit')}
            </button>
            <p className="sp-hint">
              {sendingFiles ? t('uploading') : <Txt id="support.privacy_note" />}
            </p>
          </div>
        </div>
      ) : null}
    </Form>
  );
}

export function ErrorBoundary() {
  return <SupportError />;
}

export default function SupportRoute() {
  const {ready, yours, salesEmail, discordInvite} = useLoaderData<typeof loader>();
  return (
    <div className="page-shell sp-page">
      <header className="page-header">
        <Txt id="support.title" as="h1" className="page-title" />
        <Txt id="support.lede" as="p" className="page-description" />
        <Txt id="support.languages" as="p" className="sp-hint" />
      </header>

      <div className="sp-layout">
        <div className="sp-main">
          {ready ? (
            <TicketForm />
          ) : (
            <p role="status" className="sp-banner">
              {t('unavailable')}
            </p>
          )}
        </div>

        <aside className="sp-aside">
          {yours.length ? (
            <section className="sp-card">
              <h2 className="sp-card-title">{t('yours_title')}</h2>
              <p>{t('yours_note')}</p>
              <TicketList tickets={yours} />
            </section>
          ) : null}

          <section className="sp-card">
            <h2 className="sp-card-title">{t('find_title')}</h2>
            <p>{t('find_body')}</p>
            <Link to="/support/find" className="od-btn od-btn-secondary od-btn-sm">
              {t('find_cta')}
            </Link>
          </section>

          <section className="sp-card">
            <h2 className="sp-card-title">{t('community_title')}</h2>
            <p>{t('community_body')}</p>
            <a href={discordInvite} target="_blank" rel="noopener noreferrer" className="od-btn od-btn-secondary od-btn-sm">
              {t('community_cta')}
            </a>
          </section>

          <section className="sp-card">
            <h2 className="sp-card-title">{t('topics_title')}</h2>
            <ul className="sp-links">
              {HELP_LINKS.map((l) => (
                <li key={l.key}>
                  <Link prefetch="intent" to={legalHref(l.to, 'en')}>
                    {t(l.key)}
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="sp-card" id="sales">
            <h2 className="sp-card-title">{t('sales_title')}</h2>
            <p>
              <Txt id="support.sales_body" />{' '}
              <a href={`mailto:${salesEmail}`}>{salesEmail}</a>
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
