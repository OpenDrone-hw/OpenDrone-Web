import {useEffect, useId, useRef, useState} from 'react';
import {useLoaderData, useNavigate} from 'react-router';
import type {Route} from './+types/support';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {searchOdooTickets} from '~/lib/support/odoo';
import {SupportThread} from '~/components/SupportThread';
import {FeedbackModal} from '~/components/FeedbackModal';
import {buildSeoMeta} from '~/lib/seo';
import {Txt} from '~/components/Txt';
import {copy, copyText, editAttrs} from '~/lib/copy';

/**
 * Words come from `content/copy/support.json`; everything that makes the widget
 * work does not. Sessions, polling, the Discord relay, Turnstile, the file
 * limits and every endpoint stay in this file, and the error strings the
 * `/api/support/*` routes send back are their copy, not this page's - they are
 * rendered verbatim.
 *
 * Where a string sits next to a glyph or a dynamic value the text is read with
 * `copyText` and the annotation is put on the element that owns it, rather than
 * wrapping it in a `<Txt>` span. `.support-relay-trace li > span` colours the
 * TX/RX tag, so an extra span there would paint the sentence gold.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('support.meta_title') ?? 'Support',
    description: copyText('support.meta_description') ?? '',
    robots: 'noindex,nofollow',
  });

type LoaderData =
  | {
      phase: 'native';
      discordInvite: string;
      email: string;
      existingConversation: boolean;
    }
  | {
      phase: 'intake';
      discordInvite: string;
      turnstileSiteKey: string | null;
      identity: {name: string; email: string} | null;
    }
  | {
      phase: 'active';
      ticket: {
        pid: string;
        subject: string;
        status: 'open' | 'awaiting' | 'progress' | 'resolved';
        customerName: string;
        product?: string;
        firmware?: string;
        openedAt: number;
      };
    };

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  if (context.catalog.shopifyPreview) {
    const url = new URL(request.url);
    return {
      phase: 'native' as const,
      discordInvite:
        env.DISCORD_SUPPORT_INVITE ?? 'https://discord.gg/ABajnacUsS',
      email: env.PUBLIC_COMPANY_EMAIL || 'contact@opendrone.be',
      existingConversation: url.searchParams.get('existing') === '1',
    } satisfies LoaderData;
  }

  // `?new=1` is the explicit "open another ticket" entry point from the
  // /contact page when the user already has an active ticket. Skip the
  // cookie-active redirect so the intake form is reachable; the new
  // ticket will replace the cookie focus on submission. The previous
  // ticket continues to live in the Discord thread + Odoo (erp/addons/
  // incutec_support) and remains visible in /support/tickets.
  const url = new URL(request.url);
  const forceNew = url.searchParams.get('new') === '1';

  // Cookie-bound active ticket takes precedence - that's the live thread.
  const cookie = readSupportCookie(request);
  const cookieTicket = forceNew ? null : await verifyTicket(env, cookie);
  if (cookieTicket) {
    const [meta] = await searchOdooTickets(env, {threadId: cookieTicket.tid, limit: 1});
    return {
      phase: 'active' as const,
      ticket: {
        pid: cookieTicket.pid ?? '',
        subject:
          meta?.subject ?? copyText('support.subject_fallback') ?? 'Support ticket',
        status: (meta?.status === 'closed'
          ? 'resolved'
          : 'open') as LoaderData extends {phase: 'active'; ticket: {status: infer S}}
          ? S
          : never,
        customerName: cookieTicket.name,
        product: meta?.product,
        firmware: meta?.firmware,
        openedAt: meta?.openedAt ?? cookieTicket.createdAt,
      },
    } satisfies LoaderData;
  }

  const discordInvite =
    env.DISCORD_SUPPORT_INVITE ?? 'https://discord.gg/ABajnacUsS';

  // The desk used to open only for a signed-in Shopify customer, whose
  // name and email it read from the account. Odoo owns accounts now and
  // the shop lives on another domain, so the intake asks for the two
  // fields itself; Turnstile, the honeypot and the rate limits are the
  // gate. A returning visitor's cookie fills them in.
  return {
    phase: 'intake' as const,
    discordInvite,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
    identity: await verifyTicket(env, cookie).then((t) =>
      t ? {name: t.name, email: t.email} : null,
    ),
  } satisfies LoaderData;
}

export default function SupportRoute() {
  const data = useLoaderData<typeof loader>();
  if (data.phase === 'native') {
    return (
      <div className="page-shell">
        <section className="support-intake-shell">
          <Txt id="support.title" as="h1" />
          <p>
            Ask the OpenDrone community and support team directly on Discord,
            or email Incutec for order and account questions.
          </p>
          <div className="support-intake-form-actions">
            <a
              className="od-btn od-btn-primary"
              href={data.discordInvite}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Discord support
            </a>
            <a className="od-btn od-btn-secondary" href={`mailto:${data.email}`}>
              Email {data.email}
            </a>
          </div>
          {data.existingConversation ? (
            <p className="support-intake-note">
              Contact support through Discord or email to continue an existing
              conversation. Include your ticket reference if you have it.
            </p>
          ) : null}
        </section>
      </div>
    );
  }
  if (data.phase === 'intake') {
    return (
      <IntakeView
        discordInvite={data.discordInvite}
        turnstileSiteKey={data.turnstileSiteKey}
        identity={data.identity}
      />
    );
  }
  return <ActiveView ticket={data.ticket} />;
}

/** Which way each relay step runs. The words are copy; the direction is not. */
const RELAY: Array<{id: string; dir: 'tx' | 'rx'}> = [
  {id: 'you-type', dir: 'tx'},
  {id: 'bot-posts', dir: 'tx'},
  {id: 'engineer-answers', dir: 'rx'},
  {id: 'bot-relays', dir: 'rx'},
];

/**
 * The product picker. `value` is what the Discord relay files the ticket under,
 * so it is structure and stays here; only the label a human reads is copy.
 * `<option>` can hold text and nothing else, so these are read with `copyText`
 * rather than rendered through `<Txt>`.
 */
const PRODUCT_OPTIONS: Array<{value: string; key: string}> = [
  {value: '', key: 'placeholder'},
  {value: 'OpenESC', key: 'openesc'},
  {value: 'OpenFC', key: 'openfc'},
  {value: 'OpenRX', key: 'openrx'},
  {value: 'OpenMotor', key: 'openmotor'},
  {value: 'OpenFrame', key: 'openframe'},
  {value: 'Other', key: 'other'},
];

function IntakeView({
  discordInvite,
  turnstileSiteKey,
  identity,
}: {
  discordInvite: string;
  turnstileSiteKey: string | null;
  identity: {name: string; email: string} | null;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetId = useRef<string | null>(null);
  const formId = useId();
  const navigate = useNavigate();

  // Turnstile script.
  useEffect(() => {
    if (!turnstileSiteKey) return;
    const SCRIPT_ID = 'cf-turnstile-script';
    function render() {
      const cf = (window as unknown as {turnstile?: Turnstile}).turnstile;
      if (!cf || !turnstileContainerRef.current) return;
      if (turnstileWidgetId.current) return;
      const id = cf.render(turnstileContainerRef.current, {
        sitekey: turnstileSiteKey!,
        theme: 'dark',
        size: 'flexible',
      });
      turnstileWidgetId.current = id ?? null;
    }
    if ((window as unknown as {turnstile?: Turnstile}).turnstile) {
      render();
      return;
    }
    if (document.getElementById(SCRIPT_ID)) return;
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [turnstileSiteKey]);

  function appendFiles(incoming: FileList | null): string | null {
    if (!incoming?.length) return null;
    const next = [...files];
    for (const f of Array.from(incoming)) {
      if (next.length >= 5) return copyText('support.err_max_files') ?? 'Max 5 files.';
      if (f.size > 8 * 1024 * 1024) {
        // `{name}` rather than a prefix plus a fragment: the sentence stays one
        // editable string, the filename stays a runtime value.
        return (copyText('support.err_file_too_big') ?? '{name}: over 8 MB.').replace(
          '{name}',
          f.name,
        );
      }
      const total = next.reduce((s, x) => s + x.size, 0) + f.size;
      if (total > 24 * 1024 * 1024) {
        return copyText('support.err_total_too_big') ?? 'Total over 24 MB.';
      }
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
      next.push(f);
    }
    setFiles(next);
    return null;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    fd.delete('files');
    files.forEach((f) => fd.append('files', f));
    try {
      const res = await fetch('/api/support/start', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const json = (await res.json()) as
        | {ok: true; pid?: string}
        | {ok: false; message: string; code?: string};
      if (json.ok) {
        // Loader on /support will see the new cookie and render the active state.
        void navigate('/support', {replace: true});
      } else {
        // Server copy, rendered verbatim: `/api/support/start` owns these.
        setError(json.message);
        const cf = (window as unknown as {turnstile?: Turnstile}).turnstile;
        if (cf && turnstileWidgetId.current) cf.reset(turnstileWidgetId.current);
      }
    } catch (err) {
      console.error('[support] start failed', err);
      setError(
        copyText('support.err_unreachable') ??
          'Could not reach the server. Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="od-page-frame od-page-narrow">
      <header className="od-page-head">
        <Txt id="support.intake_eyebrow" as="p" className="od-eyebrow" />
        <Txt id="support.intake_title" as="h1" />
        <Txt id="support.intake_intro" as="p" />
      </header>

      <div className="support-intake-shell">
        <div className="od-tile">
          <form
            id={formId}
            className="support-intake-form"
            onSubmit={(e) => {
              void handleSubmit(e);
            }}
            noValidate
          >
            <div className="od-field-row">
              <div className="od-field">
                <label
                  htmlFor="sup-product"
                  {...editAttrs('support.field_product_label')}
                >
                  {copyText('support.field_product_label')}{' '}
                  <Txt id="support.field_product_optional" className="od-opt" />
                </label>
                <select
                  id="sup-product"
                  name="product"
                  className="od-select"
                  defaultValue=""
                  disabled={busy}
                >
                  {PRODUCT_OPTIONS.map(({value, key}) => (
                    <option key={key} value={value}>
                      {copyText(`support.product_option_${key}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="od-field">
                <label
                  htmlFor="sup-fw"
                  {...editAttrs('support.field_firmware_label')}
                >
                  {copyText('support.field_firmware_label')}{' '}
                  <Txt id="support.field_firmware_optional" className="od-opt" />
                </label>
                <input
                  id="sup-fw"
                  name="firmware"
                  type="text"
                  className="od-input"
                  maxLength={80}
                  placeholder={copyText('support.field_firmware_placeholder')}
                  disabled={busy}
                  {...editAttrs('support.field_firmware_placeholder')}
                />
              </div>
            </div>

            {/* Name and email: the desk's only identity. They used to come
                from the signed-in customer record; a returning visitor's
                ticket cookie prefills them. */}
            <div className="od-row">
              <div className="od-field">
                <label htmlFor="sup-name">
                  {copyText('support.field_name_label') ?? 'Your name'}{' '}
                  <span
                    className="od-req"
                    aria-label={copyText('support.field_required_aria')}
                  >
                    *
                  </span>
                </label>
                <input
                  id="sup-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  className="od-input"
                  required
                  minLength={2}
                  maxLength={80}
                  defaultValue={identity?.name ?? ''}
                  disabled={busy}
                />
              </div>
              <div className="od-field">
                <label htmlFor="sup-email">
                  {copyText('support.field_email_label') ?? 'Email'}{' '}
                  <span
                    className="od-req"
                    aria-label={copyText('support.field_required_aria')}
                  >
                    *
                  </span>
                </label>
                <input
                  id="sup-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  className="od-input"
                  required
                  maxLength={254}
                  defaultValue={identity?.email ?? ''}
                  disabled={busy}
                />
              </div>
            </div>

            <div className="od-field">
              <label
                htmlFor="sup-subj"
                {...editAttrs('support.field_subject_label')}
              >
                {copyText('support.field_subject_label')}{' '}
                <span
                  className="od-req"
                  aria-label={copyText('support.field_required_aria')}
                >
                  *
                </span>
              </label>
              <input
                id="sup-subj"
                name="subject"
                type="text"
                className="od-input"
                required
                minLength={4}
                maxLength={120}
                placeholder={copyText('support.field_subject_placeholder')}
                disabled={busy}
                {...editAttrs('support.field_subject_placeholder')}
              />
            </div>

            <div className="od-field">
              <label
                htmlFor="sup-msg"
                {...editAttrs('support.field_message_label')}
              >
                {copyText('support.field_message_label')}{' '}
                <span
                  className="od-req"
                  aria-label={copyText('support.field_required_aria')}
                >
                  *
                </span>
              </label>
              <textarea
                id="sup-msg"
                name="message"
                className="od-textarea"
                rows={6}
                required
                maxLength={4000}
                placeholder={copyText('support.field_message_placeholder')}
                disabled={busy}
                {...editAttrs('support.field_message_placeholder')}
              />
            </div>

            <div className="od-field">
              <label {...editAttrs('support.field_attachments_label')}>
                {copyText('support.field_attachments_label')}{' '}
                <Txt id="support.field_attachments_hint" className="od-opt" />
              </label>
              <div
                className="support-attach-strip"
                aria-label={copyText('support.attachments_strip_aria')}
              >
                {files.map((f, i) => (
                  <IntakeChip
                    key={`${f.name}-${i}`}
                    file={f}
                    onRemove={() =>
                      setFiles((prev) => prev.filter((_, idx) => idx !== i))
                    }
                  />
                ))}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const err = appendFiles(e.target.files);
                    if (err) setError(err);
                    if (e.target) e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="od-btn od-btn-secondary od-btn-sm"
                  disabled={busy || files.length >= 5}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Txt id="support.attachments_add" />
                </button>
              </div>
            </div>

            {/* Honeypot. The label is bait for bots, never shown or read out,
                so it is machinery rather than copy and stays here. */}
            <label className="sr-only" aria-hidden="true">
              Website
              <input type="text" name="website" tabIndex={-1} autoComplete="off" />
            </label>

            <div className="support-intake-form-actions">
              {turnstileSiteKey ? (
                <div
                  ref={turnstileContainerRef}
                  aria-label={copyText('support.turnstile_aria')}
                />
              ) : (
                <span className="od-turnstile" aria-hidden="true">
                  <span className="od-turnstile-box" />
                  <Txt id="support.turnstile_placeholder" />
                </span>
              )}
              <button
                type="submit"
                className="od-btn od-btn-primary"
                disabled={busy}
              >
                <Txt
                  id={busy ? 'support.submit_busy' : 'support.submit_idle'}
                />
              </button>
            </div>

            {error ? (
              <p className="support-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </div>
        <Txt
          id="support.help_one_ticket"
          as="p"
          className="od-help"
          style={{marginTop: 12, textAlign: 'center'}}
        />
        <p className="od-help" style={{marginTop: 8, textAlign: 'center'}}>
          <Txt id="support.help_prefer_discord" />{' '}
          <a href={discordInvite} target="_blank" rel="noreferrer noopener">
            <Txt id="support.help_prefer_discord_link" />
          </a>
        </p>
      </div>
    </article>
  );
}

function IntakeChip({file, onRemove}: {file: File; onRemove: () => void}) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  return (
    <span className={`support-attach-chip${isImage ? ' is-image' : ''}`}>
      {isImage && thumb ? (
        <img
          className="od-thumb"
          src={thumb}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <span>📎 {file.name}</span>
      <span className="od-help" style={{fontSize: 10}}>
        {formatBytes(file.size)}
      </span>
      {/* The accessible name of a control, not prose: it is the filename plus
          the verb for the action, and it has no visible counterpart. Stays. */}
      <button
        type="button"
        className="od-x"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

function ActiveView({
  ticket,
}: {
  ticket: {
    pid: string;
    subject: string;
    status: 'open' | 'awaiting' | 'progress' | 'resolved';
    customerName: string;
  };
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const navigate = useNavigate();

  async function closeAndExit() {
    try {
      await fetch('/api/support/close', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      /* still navigate away - the cookie cleared if the call landed */
    }
    // Send the user to their account history - the closed thread now
    // appears under "Resolved" so the conversation isn't lost.
    void navigate('/account/support', {replace: true});
  }

  return (
    <div className="od-page-frame od-page-wide">
      <SupportThread
        mode="live"
        ticket={ticket}
        onEnd={() => setFeedbackOpen(true)}
      />
      <FeedbackModal
        open={feedbackOpen}
        onSkip={() => {
          setFeedbackOpen(false);
          void closeAndExit();
        }}
        onSubmitted={() => {
          setFeedbackOpen(false);
          void closeAndExit();
        }}
      />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Turnstile = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: 'dark' | 'light' | 'auto';
      size?: 'normal' | 'compact' | 'flexible';
      callback?: (token: string) => void;
    },
  ) => string | undefined;
  reset: (id?: string) => void;
};
