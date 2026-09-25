import {useEffect, useRef, useState} from 'react';
import {data, Form, Link, useActionData, useFetcher, useLoaderData, useNavigation, useSearchParams} from 'react-router';
import {Paperclip} from 'lucide-react';
import type {Route} from './+types/support_.t.$ref';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {CopyLink, FilePicker, fill, StatusPill, Stamp} from '~/components/SupportUi';
import {supportRateLimit} from '~/lib/support/limits';
import {notifyEnabled} from '~/lib/support/notify';
import {authorizedTicket, originOf, sameOrigin, secureCookies, supportDeps, supportReady} from '~/lib/support/server';
import {
  addCustomerReply,
  closeTicket,
  freshResumeUrl,
  publicMessage,
  publicTicket,
  resetLink,
  syncTicket,
  type PublicMessage,
  type PublicTicket,
} from '~/lib/support/tickets';
import {parseTicketRef, withTicket} from '~/lib/support/tokens';
import {extractAttachments} from '~/lib/support/uploads';
import type {TicketStatus} from '~/lib/support/store';

/**
 * One ticket: status, the conversation with the team, a reply box and the
 * private link that brings the customer back. The page asks
 * /api/support/tickets/<ref> for new replies while it is open. Only a
 * browser holding the ticket in its signed cookie (set on creation, by a
 * resume link or by /support/find) may open it.
 */
export const meta: Route.MetaFunction = () => [
  ...buildSeoMeta({title: copyText('support.meta_title') ?? 'Support', description: ''}),
  {name: 'robots', content: 'noindex, nofollow'},
];

const t = (key: string, vars: Record<string, string> = {}) => fill(copyText(`support.${key}`), vars);

const NO_STORE = {'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow'};

type Loaded =
  | {found: false}
  | {found: true; ticket: PublicTicket; messages: PublicMessage[]; link: string; notify: boolean};

export async function loader({request, params, context}: Route.LoaderArgs) {
  const env = context.env;
  const ref = parseTicketRef(params.ref);
  if (!ref || !supportReady(env)) return data<Loaded>({found: false}, {status: 404, headers: NO_STORE});
  const deps = supportDeps(env, originOf(request), context.waitUntil);
  const {ticket} = await authorizedTicket(deps, request, ref);
  if (!ticket) return data<Loaded>({found: false}, {status: 404, headers: NO_STORE});
  const synced = (await syncTicket(deps, ticket)).ticket;
  await deps.store.updateTicket(ref, {customerSeenAt: Date.now()});
  const messages = await deps.store.messages(ref);
  return data<Loaded>(
    {
      found: true,
      ticket: publicTicket(synced),
      messages: messages.map(publicMessage),
      link: await freshResumeUrl(deps, synced),
      notify: notifyEnabled(env),
    },
    {headers: NO_STORE},
  );
}

type ActionResult = {ok: boolean; intent: string; error?: string; file?: string; at: number};

export async function action({request, params, context}: Route.ActionArgs) {
  const env = context.env;
  const answer = (body: Omit<ActionResult, 'at'>, status = 200, headers: Record<string, string> = {}) =>
    data<ActionResult>({...body, at: Date.now()}, {status, headers: {...NO_STORE, ...headers}});
  const ref = parseTicketRef(params.ref);
  if (!sameOrigin(request)) return answer({ok: false, intent: 'unknown', error: 'err_forbidden'}, 403);
  if (!ref || !supportReady(env)) return answer({ok: false, intent: 'unknown', error: 'err_unavailable'}, 404);
  const deps = supportDeps(env, originOf(request), context.waitUntil);
  const {ticket, cookie} = await authorizedTicket(deps, request, ref);
  if (!ticket) return answer({ok: false, intent: 'unknown', error: 'err_forbidden'}, 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer({ok: false, intent: 'reply', error: 'err_send'}, 400);
  }
  const intent = String(form.get('intent') ?? 'reply');

  try {
    if (intent === 'solve') {
      await closeTicket(deps, ticket, 'you');
      return answer({ok: true, intent});
    }
    if (intent === 'reset') {
      const next = await resetLink(deps, ticket);
      const setCookie = await withTicket(env, cookie, {r: ref, k: next.linkVersion}, secureCookies(request));
      return answer({ok: true, intent}, 200, {'Set-Cookie': setCookie});
    }
    if (!supportRateLimit('reply', ref).allowed) return answer({ok: false, intent, error: 'err_rate'}, 429);
    const files = await extractAttachments(form);
    if (!files.ok) return answer({ok: false, intent, error: `file_${files.problem}`, file: files.file}, 400);
    const result = await addCustomerReply(deps, ticket, String(form.get('message') ?? ''), files.files);
    if (!result.ok) return answer({ok: false, intent, error: `err_${result.error}`}, 400);
    return answer({ok: true, intent});
  } catch (err) {
    console.error('[support] ticket action failed', ref, intent, err instanceof Error ? err.message : 'error');
    return answer({ok: false, intent, error: 'err_send'}, 502);
  }
}

const HINT: Record<TicketStatus, string> = {
  open: 'status_open_hint',
  answered: 'status_answered_hint',
  waiting: 'status_waiting_hint',
  closed: 'status_closed_hint',
};

function Message({m}: {m: PublicMessage}) {
  if (m.role === 'system') {
    return (
      <li className="sp-event">
        <span>{t(`system_${m.body}`)}</span> <Stamp at={m.at} />
      </li>
    );
  }
  const mine = m.role === 'customer';
  return (
    <li className={`sp-msg ${mine ? 'sp-msg-you' : 'sp-msg-team'}`}>
      <div className="sp-msg-head">
        <span className="sp-msg-author">
          {mine ? t('you') : m.author}
          {mine ? null : <span className="sp-msg-team-label"> · {t('team')}</span>}
        </span>
        <Stamp at={m.at} />
      </div>
      {m.body ? <div className="sp-msg-body">{m.body}</div> : null}
      {m.attachments.length ? (
        <ul className="sp-msg-files" aria-label={t('attachment')}>
          {m.attachments.map((a) => (
            <li key={a.id}>
              <Paperclip size={13} aria-hidden="true" />
              {a.href ? (
                <a href={a.href} target="_blank" rel="noopener noreferrer">
                  {a.filename}
                </a>
              ) : (
                <span>{a.filename}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type Poll = {ok: boolean; status?: TicketStatus; messages?: PublicMessage[]};

/** Ask for new replies every 8 s while visible, slowing to 30 s after five quiet minutes. */
function useLiveMessages(ref: string, initial: PublicMessage[], initialStatus: TicketStatus) {
  const fetcher = useFetcher<Poll>();
  const [messages, setMessages] = useState(initial);
  const [status, setStatus] = useState(initialStatus);
  const [offline, setOffline] = useState(false);
  const lastChange = useRef(Date.now());
  const lastSeq = messages.at(-1)?.seq ?? 0;

  // A loader revalidation (after a reply) is the new baseline.
  useEffect(() => {
    setMessages(initial);
    setStatus(initialStatus);
  }, [initial, initialStatus]);

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (!d.ok) {
      setOffline(true);
      return;
    }
    setOffline(false);
    if (d.status) setStatus(d.status);
    if (d.messages?.length) {
      lastChange.current = Date.now();
      setMessages((cur) => {
        const seen = new Set(cur.map((m) => m.seq));
        return [...cur, ...d.messages!.filter((m) => !seen.has(m.seq))];
      });
    }
  }, [fetcher.data]);

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const quiet = Date.now() - lastChange.current > 5 * 60 * 1000;
      timer = window.setTimeout(() => {
        if (document.visibilityState === 'visible' && fetcher.state === 'idle') {
          void fetcher.load(`/api/support/tickets/${ref}?after=${lastSeq}`);
        }
        tick();
      }, quiet ? 30_000 : 8_000);
    };
    tick();
    return () => window.clearTimeout(timer);
    // fetcher identity is stable enough; restarting on every state change would reset the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, lastSeq]);

  return {messages, status, offline};
}

function Ticket({ticket, messages: initial, link, notify}: Extract<Loaded, {found: true}>) {
  const [params] = useSearchParams();
  const [isNew] = useState(params.get('new') === '1');

  // The "ticket opened" banner shows once: drop ?new=1 so a reload or a
  // bookmark does not bring it back.
  useEffect(() => {
    if (params.get('new') === '1') window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [params]);
  const result = useActionData<ActionResult>();
  const nav = useNavigation();
  const busyIntent = nav.state !== 'idle' ? String(nav.formData?.get('intent') ?? '') : '';
  const {messages, status, offline} = useLiveMessages(ticket.ref, initial, ticket.status);
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;

  useEffect(() => {
    if (result?.ok && result.intent === 'reply') formRef.current?.reset();
  }, [result]);

  useEffect(() => {
    if (count > initial.length) endRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }, [count, initial.length]);

  const error = result && !result.ok && result.error ? t(result.error, {file: result.file ?? ''}) : null;

  return (
    <div className="page-shell sp-page">
      <nav className="sp-crumbs" aria-label="Breadcrumb">
        <Link to="/support">{t('title')}</Link>
        <span aria-hidden="true">/</span>
        <span>{ticket.ref}</span>
      </nav>
      <header className="page-header sp-ticket-head">
        <h1 className="page-title sp-ticket-title">{ticket.subject}</h1>
      </header>

      {isNew ? (
        <section className="sp-created" aria-labelledby="sp-created-title">
          <h2 id="sp-created-title" className="sp-card-title">
            {t('created_title')}
          </h2>
          <p>{t('created_body')}</p>
          <CopyLink url={link} />
        </section>
      ) : null}

      <div className="sp-layout sp-layout-ticket">
        <div className="sp-main">
          <div className={`sp-state sp-state-${status}`} role="status">
            <StatusPill status={status} />
            <p>{t(HINT[status])}</p>
          </div>

          <section aria-labelledby="sp-conversation">
            <h2 id="sp-conversation" className="sp-visually-hidden">
              {t('conversation')}
            </h2>
            <ol className="sp-thread" aria-live="polite">
              {messages.map((m) => (
                <Message key={m.seq} m={m} />
              ))}
            </ol>
            <div ref={endRef} />
            <p className="sp-live">
              <span className={`sp-live-dot${offline ? ' is-off' : ''}`} aria-hidden="true" />
              {offline ? t('offline') : t('live')}
            </p>
          </section>

          <Form ref={formRef} method="post" encType="multipart/form-data" className="sp-composer">
            <input type="hidden" name="intent" value="reply" />
            <label className="sp-field">
              <span className="sp-label">{t('reply_label')}</span>
              <textarea
                name="message"
                rows={4}
                maxLength={4000}
                placeholder={t('reply_placeholder')}
                className="sp-input sp-textarea"
              />
            </label>
            {error ? (
              <p role="alert" className="sp-error">
                {error}
              </p>
            ) : null}
            <div className="sp-composer-row">
              <FilePicker compact disabled={busyIntent === 'reply'} />
              <button type="submit" className="od-btn od-btn-primary" disabled={busyIntent === 'reply'}>
                {busyIntent === 'reply' ? t('sending') : t('send')}
              </button>
            </div>
          </Form>
          {status !== 'closed' ? (
            <Form method="post" className="sp-solve">
              <input type="hidden" name="intent" value="solve" />
              <button type="submit" className="od-btn od-btn-ghost od-btn-sm" disabled={busyIntent === 'solve'}>
                {t('solve')}
              </button>
            </Form>
          ) : null}
        </div>

        <aside className="sp-aside">
          <section className="sp-card">
            <h2 className="sp-card-title">{t('link_title')}</h2>
            <p>{t('link_body')}</p>
            {isNew ? null : <CopyLink url={link} />}
            {result?.ok && result.intent === 'reset' ? (
              <p role="status" className="sp-hint">
                {t('reset_done')}
              </p>
            ) : null}
            <Form
              method="post"
              onSubmit={(e) => {
                if (!window.confirm(t('reset_confirm'))) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="reset" />
              <button type="submit" className="od-btn od-btn-ghost od-btn-sm sp-reset">
                {t('reset')}
              </button>
            </Form>
            <p className="sp-hint">{t(notify ? 'notify_on' : 'notify_off')}</p>
          </section>

          <section className="sp-card">
            <dl className="sp-facts">
              <div>
                <dt>{t('ticket_label')}</dt>
                <dd className="sp-mono">{ticket.ref}</dd>
              </div>
              <div>
                <dt>{t('opened_label')}</dt>
                <dd>
                  <Stamp at={ticket.createdAt} day />
                </dd>
              </div>
              {ticket.orderNumber ? (
                <div>
                  <dt>{t('order_label')}</dt>
                  <dd className="sp-mono">{ticket.orderNumber}</dd>
                </div>
              ) : null}
              {ticket.product ? (
                <div>
                  <dt>{t('product_label')}</dt>
                  <dd>{ticket.product}</dd>
                </div>
              ) : null}
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

export default function TicketRoute() {
  const loaded = useLoaderData<typeof loader>();
  if (!loaded.found) {
    return (
      <div className="page-shell sp-page">
        <header className="page-header">
          <h1 className="page-title">{t('gone_title')}</h1>
          <p className="page-description">{t('gone_body')}</p>
        </header>
        <div className="sp-actions">
          <Link to="/support/find" className="od-btn od-btn-primary">
            {t('find_cta')}
          </Link>
          <Link to="/support" className="od-btn od-btn-secondary">
            {t('find_new')}
          </Link>
        </div>
      </div>
    );
  }
  return <Ticket {...loaded} />;
}
