import {useEffect, useMemo, useState} from 'react';
import {Link, redirect, useLoaderData, type HeadersFunction} from 'react-router';
import type {Route} from './+types/support.tickets';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {searchOdooTickets, type OdooTicketStatus} from '~/lib/support/odoo';
import {SupportThread, type ThreadMessage} from '~/components/SupportThread';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

type AccountTicket = {
  tid: string;
  pid: string;
  subject: string;
  openedAt: number;
  closedAt: number | null;
  lastActivityAt: number;
  status: OdooTicketStatus;
};

/** One copy string with `{placeholders}` filled in. */
function fill(id: string, fallback: string, vars: Record<string, string>) {
  let out = copyText(id) ?? fallback;
  for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, v);
  return out;
}

export const headers: HeadersFunction = () => ({
  'Cache-Control': 'private, no-store',
});

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('account.support.meta_title') ?? 'Support tickets',
    description:
      copyText('account.support.meta_description') ??
      'Your OpenDrone support history.',
    robots: 'noindex,nofollow',
  });

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;

  // Identity is the signed ticket cookie: the email the visitor opened a
  // ticket with, or the one a resume link re-minted. There is no customer
  // account to authenticate against any more (contract section 4), so a
  // visitor without a cookie is sent to the desk to open one or to ask
  // for a resume link by email.
  const cookie = readSupportCookie(request);
  const cookieTicket = await verifyTicket(env, cookie);
  if (!cookieTicket?.email) throw redirect('/support');

  const customerName =
    cookieTicket.name ||
    copyText('account.support.customer_fallback') ||
    'You';
  const activeCookieTid = cookieTicket.tid;
  const activeCookiePid = cookieTicket.pid ?? null;

  const found = await searchOdooTickets(env, {
    email: cookieTicket.email,
    status: 'all',
    limit: 100,
  });
  const indexed: AccountTicket[] = found.map((t) => ({
    tid: t.tid,
    pid: t.pid,
    subject: t.subject,
    openedAt: t.openedAt,
    closedAt: t.closedAt,
    lastActivityAt: t.lastActivityAt,
    status: t.status,
  }));

  // When Odoo has nothing yet for this email (bridge unreachable, or the
  // mirror write for this ticket hasn't landed), synthesise a single
  // entry from the cookie so the page reflects reality and the live
  // thread is reachable from the list.
  const tickets: AccountTicket[] =
    indexed.length === 0 && cookieTicket
      ? [
          {
            tid: cookieTicket.tid,
            pid: cookieTicket.pid ?? '',
            subject:
              copyText('account.support.default_subject') ?? 'Support ticket',
            openedAt: cookieTicket.createdAt,
            closedAt: null,
            lastActivityAt: cookieTicket.createdAt,
            status: 'open' as const,
          },
        ]
      : indexed;

  return {
    tickets,
    customerName,
    activeCookieTid,
    activeCookiePid,
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

export default function AccountSupportRoute() {
  const {tickets, customerName, activeCookiePid} =
    useLoaderData<typeof loader>() as LoaderData;

  const open = useMemo(
    () => tickets.filter((t) => t.status === 'open'),
    [tickets],
  );
  const resolved = useMemo(
    () => tickets.filter((t) => t.status === 'closed'),
    [tickets],
  );

  const initialPid =
    activeCookiePid ?? open[0]?.pid ?? resolved[0]?.pid ?? null;
  const [activePid, setActivePid] = useState<string | null>(initialPid);

  return (
    <div className="od-page-frame od-page-wide">
      <header className="od-page-head">
        <Txt id="account.support.eyebrow" as="p" className="od-eyebrow" />
        <Txt id="account.support.title" as="h1" />
        <Txt id="account.support.lede" as="p" />
      </header>

      {tickets.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="account-support">
          <aside
            className="account-support-list"
            aria-label={copyText('account.support.list_aria') ?? 'Tickets'}
          >
            <div className="account-support-list-head">
              <Txt id="account.support.list_heading" as="h3" />
              <Link prefetch="viewport"
                to="/support"
                className="od-btn od-btn-secondary od-btn-sm"
              >
                <Txt id="account.support.new" />
              </Link>
            </div>

            {open.length > 0 ? (
              <div className="account-support-list-section">
                {fill('account.support.section_open', 'Open · {count}', {
                  count: String(open.length),
                })}
              </div>
            ) : null}
            {open.map((t) => (
              <TicketRow
                key={t.tid}
                ticket={t}
                isActive={t.pid === activePid}
                onSelect={() => setActivePid(t.pid)}
              />
            ))}

            {resolved.length > 0 ? (
              <div className="account-support-list-section">
                {fill('account.support.section_resolved', 'Resolved · {count}', {
                  count: String(resolved.length),
                })}
              </div>
            ) : null}
            {resolved.map((t) => (
              <TicketRow
                key={t.tid}
                ticket={t}
                isActive={t.pid === activePid}
                onSelect={() => setActivePid(t.pid)}
              />
            ))}
          </aside>

          <main className="account-support-detail">
            <DetailPane
              pid={activePid}
              ticket={tickets.find((t) => t.pid === activePid) ?? null}
              isCookieActive={activePid !== null && activePid === activeCookiePid}
              customerName={customerName}
            />
          </main>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="od-tile" style={{textAlign: 'center', padding: 48}}>
      <Txt
        id="account.support.empty_eyebrow"
        as="p"
        className="od-tile-eyebrow"
        style={{color: 'var(--od-pcb-gold-2)'}}
      />
      <Txt id="account.support.empty_title" as="h3" />
      <Txt id="account.support.empty_body" as="p" />
      <Link prefetch="viewport" to="/support" className="od-btn od-btn-primary">
        <Txt id="account.support.empty_cta" />
      </Link>
    </div>
  );
}

function TicketRow({
  ticket,
  isActive,
  onSelect,
}: {
  ticket: AccountTicket;
  isActive: boolean;
  onSelect: () => void;
}) {
  const last = useMemo(
    () => relativeTime(ticket.lastActivityAt || ticket.openedAt),
    [ticket.lastActivityAt, ticket.openedAt],
  );
  const status = mapStatus(ticket);
  return (
    <button
      type="button"
      className={`account-ticket-row${isActive ? ' is-active' : ''}`}
      aria-label={fill('account.support.row_aria', 'Open ticket {subject}', {
        subject: ticket.subject,
      })}
      aria-current={isActive ? 'true' : undefined}
      onClick={onSelect}
    >
      <div className="od-row-top">
        <span className="od-subj">
          {ticket.subject ||
            (copyText('account.support.untitled') ?? 'Untitled ticket')}
        </span>
        <span className="od-time">{last}</span>
      </div>
      <div className="od-row-bot">
        <StatusPill status={status} />
        <span className="od-pid">#{ticket.pid}</span>
      </div>
    </button>
  );
}

function StatusPill({
  status,
}: {
  status: 'open' | 'awaiting' | 'progress' | 'resolved';
}) {
  const map = {
    open: 'is-open',
    awaiting: 'is-awaiting',
    progress: 'is-progress',
    resolved: 'is-resolved',
  } as const;
  const label = {
    open: 'account.support.status_open',
    awaiting: 'account.support.status_awaiting',
    progress: 'account.support.status_progress',
    resolved: 'account.support.status_resolved',
  } as const;
  return (
    <Txt
      id={label[status]}
      className={`od-status ${map[status]}`}
      role="status"
    />
  );
}

function DetailPane({
  pid,
  ticket,
  isCookieActive,
  customerName,
}: {
  pid: string | null;
  ticket: AccountTicket | null;
  isCookieActive: boolean;
  customerName: string;
}) {
  if (!pid || !ticket) {
    return (
      <Txt
        id="account.support.pick"
        as="div"
        className="account-support-empty"
      />
    );
  }
  // /account/support is the read-only history view. Live interaction
  // (composer, attachments, end-ticket) lives on /support — having two
  // places to type into the same Discord thread is split-brain UX. When
  // the selected ticket is the cookie-bound one, surface a "Continue"
  // CTA that jumps to /support; everything else just renders the
  // read-only message log.
  return (
    <>
      {isCookieActive ? (
        <div className="account-support-active-banner">
          <Txt id="account.support.active_banner" />
          <Link prefetch="viewport" to="/support" className="od-btn od-btn-primary od-btn-sm">
            <Txt id="account.support.continue" />
          </Link>
        </div>
      ) : null}
      <ReadOnlyThread pid={pid} customerName={customerName} ticket={ticket} />
    </>
  );
}

function ReadOnlyThread({
  pid,
  customerName,
  ticket,
}: {
  pid: string;
  customerName: string;
  ticket: AccountTicket;
}) {
  const [state, setState] = useState<
    | {phase: 'loading'}
    | {phase: 'error'; message: string}
    | {phase: 'ready'; messages: ThreadMessage[]}
  >({phase: 'loading'});

  useEffect(() => {
    let cancelled = false;
    setState({phase: 'loading'});
    void (async () => {
      try {
        const res = await fetch(`/api/support/thread/${pid}`, {
          credentials: 'same-origin',
        });
        const json = (await res.json()) as
          | {ok: true; messages: ThreadMessage[]}
          | {ok: false; message: string};
        if (cancelled) return;
        if (!json.ok) {
          setState({phase: 'error', message: json.message});
          return;
        }
        setState({phase: 'ready', messages: json.messages});
      } catch (err) {
        if (cancelled) return;
        setState({
          phase: 'error',
          message:
            err instanceof Error
              ? err.message
              : (copyText('account.support.load_failed') ??
                'Could not load thread.'),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid]);

  if (state.phase === 'loading') {
    return (
      <Txt
        id="account.support.loading"
        as="div"
        className="account-support-empty"
      />
    );
  }
  if (state.phase === 'error') {
    return (
      <div className="account-support-empty">
        <Txt id="account.support.load_error" /> {state.message}
      </div>
    );
  }
  return (
    <SupportThread
      mode="readonly"
      embedded
      ticket={{
        pid: ticket.pid,
        subject:
          ticket.subject ||
          (copyText('account.support.default_subject') ?? 'Support ticket'),
        status: mapStatus(ticket),
        customerName,
      }}
      initialMessages={state.messages}
    />
  );
}

function mapStatus(
  t: AccountTicket,
): 'open' | 'awaiting' | 'progress' | 'resolved' {
  if (t.status === 'closed') return 'resolved';
  // No fine-grained "awaiting/progress" tracking yet — index has open|closed.
  // Treat all open tickets as plain "open" for now.
  return 'open';
}

function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const diff = Date.now() / 1000 - unixSeconds;
  const ago = (id: string, fallback: string, n: number) =>
    fill(`account.support.${id}`, fallback, {count: String(n)});
  if (diff < 60) return copyText('account.support.time_now') ?? 'just now';
  if (diff < 3600) return ago('time_minutes', '{count} min ago', Math.floor(diff / 60));
  if (diff < 86400) return ago('time_hours', '{count} h ago', Math.floor(diff / 3600));
  if (diff < 86400 * 14)
    return ago('time_days', '{count} d ago', Math.floor(diff / 86400));
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
