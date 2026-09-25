import {useEffect, useRef, useState, type FormEvent} from 'react';
import {data, Form, Link, useActionData, useFetcher, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {Paperclip} from 'lucide-react';
import type {Route} from './+types/support_.t.$ref';
import {buildSeoMeta} from '~/lib/seo';
import {copyText} from '~/lib/copy';
import {
  clearDraft,
  CopyLink,
  FilePicker,
  fill,
  guardSubmit,
  usePost,
  MessageBox,
  StatusPill,
  Stamp,
  SupportError,
  useDraft,
} from '~/components/SupportUi';
import {handleTicketAction, type TicketActionResult} from '~/lib/support/handlers';
import {notifyEnabled} from '~/lib/support/notify';
import {authorizedTicket, originOf, supportDeps, supportReady, supportHeaders} from '~/lib/support/server';
import {
  byTime,
  freshResumeUrl,
  publicMessage,
  publicTicket,
  syncTicket,
  type PublicMessage,
  type PublicTicket,
} from '~/lib/support/tickets';
import {parseTicketRef} from '~/lib/support/tokens';
import type {TicketStatus} from '~/lib/support/store';

/**
 * One ticket: status, the conversation with the team, a reply box and the
 * private link that brings the customer back. The page asks
 * /api/support/tickets/<ref> for new replies while it is open. Only a
 * browser holding the ticket in its signed cookie (set on creation, by a
 * resume link or by /support/find) may open it.
 */
/** Private, never cached, never indexed; keeps loader and action headers. */
export const headers = supportHeaders;

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

type ActionResult = TicketActionResult;

export async function action({request, params, context}: Route.ActionArgs) {
  const o = await handleTicketAction(request, context, params.ref);
  return data<ActionResult>(o.body, {status: o.status, headers: {...NO_STORE, ...(o.cookie ? {'Set-Cookie': o.cookie} : {})}});
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
      {m.body ? (
        <div className="sp-msg-body" dir="auto">
          {m.body}
        </div>
      ) : null}
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

type Poll = {ok: boolean; status?: TicketStatus; locked?: boolean; messages?: PublicMessage[]};

/**
 * Ask for new replies every 8 s while visible, slowing to 30 s after five
 * quiet minutes. `seq` is only the fetch cursor; the list is ordered by time.
 */
function useLiveMessages(ref: string, initial: PublicMessage[], initialStatus: TicketStatus, initialLocked: boolean) {
  const fetcher = useFetcher<Poll>();
  const [messages, setMessages] = useState(initial);
  const [status, setStatus] = useState(initialStatus);
  const [locked, setLocked] = useState(initialLocked);
  const [offline, setOffline] = useState(false);
  const lastChange = useRef(Date.now());
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);

  // A loader revalidation (after a reply) is the new baseline.
  useEffect(() => {
    setMessages(initial);
    setStatus(initialStatus);
    setLocked(initialLocked);
  }, [initial, initialStatus, initialLocked]);

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (!d.ok) {
      setOffline(true);
      return;
    }
    setOffline(false);
    if (d.status) setStatus(d.status);
    if (d.locked !== undefined) setLocked(d.locked);
    if (d.messages?.length) {
      lastChange.current = Date.now();
      setMessages((cur) => {
        const seen = new Set(cur.map((m) => m.seq));
        return [...cur, ...d.messages!.filter((m) => !seen.has(m.seq))].sort(byTime);
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

  /** The team locked the ticket (a 409 on send): show it now, not at the next poll. */
  function lockNow() {
    setLocked(true);
    setStatus('closed');
  }

  return {messages, status, locked, offline, lockNow};
}

type Post = ReturnType<typeof usePost<ActionResult>>['post'];

/**
 * Sends one of the ticket page's forms with fetch (the page stays, with
 * its text and files, whatever happens) and reports the answer. Without
 * JavaScript the same forms post to the page's action.
 */
function sendForm(post: Post, ref: string, intent: string, onDone: (r: ActionResult) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void post(`/api/support/tickets/${ref}`, form, {intent}).then((body) =>
      onDone(body ?? {ok: false, intent, error: 'err_send', at: Date.now()}),
    );
  };
}

/**
 * Kept on a locked ticket on purpose: the private link still opens the
 * conversation, so its holder may want to revoke it.
 */
function ReplaceLink({onSubmit, busy}: {onSubmit: (e: FormEvent<HTMLFormElement>) => void; busy: boolean}) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
  }, [asking]);
  if (!asking) {
    return (
      <button type="button" className="od-btn od-btn-ghost od-btn-sm sp-reset" onClick={() => setAsking(true)}>
        {t('reset')}
      </button>
    );
  }
  return (
    <Form method="post" className="sp-confirm" role="group" aria-label={t('reset')} onSubmit={onSubmit}>
      <input type="hidden" name="intent" value="reset" />
      <p>{t('reset_confirm')}</p>
      <div className="sp-actions">
        <button ref={confirmRef} type="submit" className="od-btn od-btn-secondary od-btn-sm" disabled={busy}>
          {t('reset_yes')}
        </button>
        <button type="button" className="od-btn od-btn-ghost od-btn-sm" onClick={() => setAsking(false)}>
          {t('reset_no')}
        </button>
      </div>
    </Form>
  );
}

function Ticket({ticket, messages: initial, link, notify}: Extract<Loaded, {found: true}>) {
  const [params] = useSearchParams();
  const [isNew] = useState(params.get('new') === '1');
  const navigate = useNavigate();

  // The "ticket opened" banner shows once: drop ?new=1 so a reload or a
  // bookmark does not bring it back. The form's saved draft is done with.
  useEffect(() => {
    if (params.get('new') === '1') {
      void navigate(`/support/t/${ticket.ref}`, {replace: true, preventScrollReset: true});
      clearDraft('new');
    }
  }, [params, navigate, ticket.ref]);
  // Without JavaScript the page's action answers; with it, sendForm.
  const actionResult = useActionData<ActionResult>();
  const [fetched, setFetched] = useState<ActionResult | null>(null);
  const result = fetched ?? actionResult;
  const {busy, sendingFiles: uploading, post} = usePost<ActionResult>();
  const [busyIntent, setBusyIntent] = useState('');
  const sendingFiles = busy && busyIntent === 'reply' && uploading;
  const revalidator = useRevalidator();
  const {messages, status, locked, offline, lockNow} = useLiveMessages(ticket.ref, initial, ticket.status, ticket.locked);
  const formRef = useRef<HTMLFormElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  // What is in the reply box, so a lock that lands mid-typing can show it as not sent.
  const [draft, setDraft] = useState('');
  const [errorDismissed, setErrorDismissed] = useState<number | null>(null);
  const count = messages.length;
  useDraft(formRef, ticket.ref);

  function done(r: ActionResult) {
    setBusyIntent('');
    setFetched(r);
    if (r.locked) lockNow();
    if (r.ok) void revalidator.revalidate();
  }
  const send = (intent: string) => {
    const handler = sendForm(post, ticket.ref, intent, done);
    return (event: FormEvent<HTMLFormElement>) => {
      if (intent === 'reply') {
        const problem = guardSubmit(event);
        setClientError(problem);
        if (problem) return;
      }
      setBusyIntent(intent);
      handler(event);
    };
  };

  useEffect(() => {
    if (result?.ok && result.intent === 'reply') {
      formRef.current?.reset();
      clearDraft(ticket.ref);
      setDraft('');
      formRef.current?.querySelector('textarea')?.focus();
    }
    if (result && !result.ok) formRef.current?.querySelector<HTMLElement>('.sp-error')?.focus();
  }, [result, ticket.ref]);

  useEffect(() => {
    if (count > initial.length) endRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  }, [count, initial.length]);

  const error =
    clientError ??
    (result && !result.ok && result.error && errorDismissed !== result.at ? t(result.error, {file: result.file ?? ''}) : null);

  return (
    <div className="page-shell sp-page">
      <nav className="sp-crumbs" aria-label="Breadcrumb">
        <Link to="/support">{t('title')}</Link>
        <span aria-hidden="true">/</span>
        <span>{ticket.ref}</span>
      </nav>
      <header className="page-header sp-ticket-head">
        <h1 className="page-title sp-ticket-title">{ticket.subject}</h1>
        {ticket.preview ? (
          <p className="page-description sp-ticket-preview" dir="auto">
            {ticket.preview}
          </p>
        ) : null}
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
            <p>{t(locked ? 'status_locked_hint' : HINT[status])}</p>
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
            {locked ? null : (
              <p className="sp-live">
                <span className={`sp-live-dot${offline ? ' is-off' : ''}`} aria-hidden="true" />
                {offline ? t('offline') : t('live')}
              </p>
            )}
          </section>

          {locked ? (
            <div className="sp-locked">
              {draft.trim() ? (
                <div className="sp-unsent">
                  <p className="sp-unsent-label">
                    <span className="sp-status sp-status-closed">{t('unsent_label')}</span> {t('unsent_body')}
                  </p>
                  <textarea readOnly value={draft} rows={4} dir="auto" className="sp-input sp-textarea" aria-label={t('unsent_label')} />
                </div>
              ) : null}
              <p>{t('locked_body')}</p>
              <Link to="/support" className="od-btn od-btn-primary">
                {t('find_new')}
              </Link>
            </div>
          ) : (
            <>
              <Form
                ref={formRef}
                method="post"
                encType="multipart/form-data"
                className="sp-composer"
                onSubmit={send('reply')}
                onInput={(e) => {
                  const el = e.target as HTMLTextAreaElement;
                  if (el.name === 'message') setDraft(el.value);
                }}
              >
                <input type="hidden" name="intent" value="reply" />
                <MessageBox label={t('reply_label')} placeholder={t('reply_placeholder')} rows={4} />
                {error ? (
                  <p role="alert" tabIndex={-1} className="sp-error">
                    {error}
                  </p>
                ) : null}
                <div className="sp-composer-row">
                  <FilePicker
                    compact
                    disabled={busyIntent === 'reply'}
                    onChange={() => {
                      setClientError(null);
                      if (result) setErrorDismissed(result.at);
                    }}
                  />
                  <button type="submit" className="od-btn od-btn-primary" disabled={busyIntent === 'reply'}>
                    {busyIntent === 'reply' ? t('sending') : t('send')}
                  </button>
                </div>
                {sendingFiles ? <p className="sp-hint">{t('uploading')}</p> : null}
              </Form>
              {status !== 'closed' ? (
                <Form method="post" className="sp-solve" onSubmit={send('solve')}>
                  <input type="hidden" name="intent" value="solve" />
                  <button type="submit" className="od-btn od-btn-ghost od-btn-sm" disabled={busyIntent === 'solve'}>
                    {t('solve')}
                  </button>
                </Form>
              ) : null}
            </>
          )}
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
            ) : (
              <ReplaceLink onSubmit={send('reset')} busy={busyIntent === 'reset'} />
            )}
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

export function ErrorBoundary() {
  return <SupportError />;
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
