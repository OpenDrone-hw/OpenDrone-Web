import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {
  Image as ImageFileIcon,
  Film,
  Headphones,
  FolderArchive,
  FileCode,
  FileText,
  File as GenericFileIcon,
  Paperclip,
} from 'lucide-react';
import {DISCORD_INVITE_URL} from '~/lib/company';

/**
 * Active-ticket chat UI. Rebuilt for the Apr-2026 design - chat-bubble
 * variant, sticky composer, inline image previews, drag-and-drop. Used
 * by /support (live mode) and /account/support (live or read-only).
 *
 * Source of truth is server-side: cookie-bound ticket + Discord thread.
 * On mount we fetch full history via /api/support/poll?initial=1 (live)
 * or /api/support/thread/:pid (read-only). Subsequent ticks are
 * cursor-based deltas. Refresh-safe by design.
 */

const POLL_INTERVAL_ACTIVE = 4000;
const POLL_INTERVAL_BACKGROUND = 15000;

const MAX_FILES = 5;
const MAX_PER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac']);
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
const CODE_EXT = new Set(['js', 'ts', 'tsx', 'jsx', 'py', 'c', 'cpp', 'h', 'hex', 'bin', 'json', 'yml', 'yaml', 'toml']);

function FileTypeIcon({ext}: {ext: string}) {
  const Icon = IMAGE_EXT.has(ext)
    ? ImageFileIcon
    : VIDEO_EXT.has(ext)
      ? Film
      : AUDIO_EXT.has(ext)
        ? Headphones
        : ARCHIVE_EXT.has(ext)
          ? FolderArchive
          : CODE_EXT.has(ext)
            ? FileCode
            : ext === 'pdf'
              ? FileText
              : GenericFileIcon;
  return <Icon size={14} strokeWidth={1.75} aria-hidden="true" />;
}

export type ThreadMessage = {
  id: string;
  role: 'helper' | 'self';
  firstName: string;
  content: string;
  createdAt: string;
  attachments: Array<{url: string; filename: string}>;
};

type LocalMessage = ThreadMessage & {
  isSelf: boolean;
  pending?: boolean;
};

type PollStats = {deltaVisible: number; pending: number};

type PollResponse =
  | {
      ok: true;
      messages: ThreadMessage[];
      closed: boolean;
      stats?: PollStats;
    }
  | {ok: false; message: string; code?: string};

type SendResponse =
  | {
      ok: true;
      id: string;
      attachments: Array<{url: string; filename: string}>;
    }
  | {ok: false; message: string};

type StatusResponse =
  | {ok: true; active: false}
  | {
      ok: true;
      active: true;
      name: string;
      email: string;
      createdAt: number;
      pid?: string;
    };

export type SupportThreadInitial = {
  pid: string;
  subject: string;
  status: 'open' | 'awaiting' | 'progress' | 'resolved';
  customerName: string;
  // Optional intake metadata surfaced in the active-ticket sidebar.
  product?: string;
  firmware?: string;
  openedAt?: number; // unix seconds
};

export interface SupportThreadProps {
  mode: 'live' | 'readonly';
  /** When provided, skips the live status/poll fetch and renders these messages. */
  initialMessages?: ThreadMessage[];
  /** Header info - provided when the parent loader knows the ticket up front. */
  ticket: SupportThreadInitial;
  /** Called when user clicks "End ticket". Parent opens the feedback modal. */
  onEnd?: () => void;
  /** When embedded inside another card (e.g. /account/support), drop the outer chrome. */
  embedded?: boolean;
}

export function SupportThread({
  mode,
  initialMessages,
  ticket,
  onEnd,
  embedded = false,
}: SupportThreadProps) {
  const [messages, setMessages] = useState<LocalMessage[]>(() =>
    (initialMessages ?? []).map((m) => ({
      ...m,
      isSelf: m.role === 'self',
    })),
  );
  const [draft, setDraft] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [composerFiles, setComposerFiles] = useState<File[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [closed, setClosed] = useState(ticket.status === 'resolved');
  const [error, setError] = useState<string | null>(null);
  // Pending replies = staff messages currently held by the moderation
  // gate. They never appear in `messages` (that's post-projection), so we
  // track them via the poll's `pending` snapshot - assigned each poll, not
  // accumulated, so it falls to zero when a moderator approves the reply.
  // Visible reply count is derived from messages directly via useMemo.
  const [pendingReplies, setPendingReplies] = useState<number>(0);

  const logRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const userScrolledUp = useRef(false);
  const composerId = useId();

  const scrollToBottom = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Track whether the user has scrolled up - if so, don't auto-scroll
  // when staff replies, so we don't yank their reading position.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distFromBottom > 80;
    };
    el.addEventListener('scroll', onScroll, {passive: true});
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!userScrolledUp.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // Auto-grow composer textarea (44 → 200px).
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, Math.max(44, el.scrollHeight))}px`;
  }, [draft]);

  // Live polling. Only runs when mode === 'live'. First tick uses
  // ?initial=1 to backfill history (refresh-safe). Subsequent ticks
  // are deltas.
  useEffect(() => {
    if (mode !== 'live') return;
    let stopped = false;
    let firstTick = true;
    let timer: number | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        // `visible` tells the server whether this delivery counts as
        // "seen": hidden-tab polls must stay eligible for the reply
        // notification email sweep.
        const vis =
          typeof document !== 'undefined' && document.hidden ? '0' : '1';
        const url = firstTick
          ? `/api/support/poll?initial=1&visible=${vis}`
          : `/api/support/poll?visible=${vis}`;
        firstTick = false;
        const res = await fetch(url, {credentials: 'same-origin'});
        if (res.status === 401) {
          if (!stopped) setError('Your session expired. Refresh to continue.');
          return;
        }
        const json = (await res.json()) as PollResponse;
        if (json.ok && json.messages.length) {
          setMessages((prev) => mergeMessages(prev, json.messages));
        }
        if (json.ok && json.stats) {
          // `pending` is a snapshot of replies currently held by the
          // moderation gate - assign it, don't accumulate. It rises when
          // a staff reply is awaiting ✅ and drops back to zero once the
          // moderator approves.
          setPendingReplies(json.stats.pending);
        }
        if (json.ok && json.closed && !closed) {
          setClosed(true);
        }
      } catch {
        /* swallow - try again next tick */
      }
      const interval =
        typeof document !== 'undefined' && document.hidden
          ? POLL_INTERVAL_BACKGROUND
          : POLL_INTERVAL_ACTIVE;
      timer = window.setTimeout(() => void tick(), interval);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [mode, closed]);

  async function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode !== 'live' || closed) return;
    const content = draft.trim();
    const filesToSend = composerFiles;
    if ((!content && !filesToSend.length) || sendBusy) return;

    const pendingId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: pendingId,
        isSelf: true,
        role: 'self',
        firstName: ticket.customerName || 'You',
        content,
        createdAt: new Date().toISOString(),
        pending: true,
        attachments: filesToSend.map((f) => ({url: '', filename: f.name})),
      },
    ]);
    setDraft('');
    setComposerFiles([]);
    setSendBusy(true);

    try {
      const fd = new FormData();
      if (content) fd.append('content', content);
      filesToSend.forEach((f) => fd.append('files', f));
      const res = await fetch('/api/support/send', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
      const json = (await res.json()) as SendResponse;
      if (!json.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  pending: false,
                  content: `${m.content}\n\n[failed: ${json.message}]`,
                }
              : m,
          ),
        );
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  pending: false,
                  attachments: json.attachments.length
                    ? json.attachments
                    : m.attachments,
                }
              : m,
          ),
        );
      }
    } catch (err) {
      console.error('[support-thread] send failed', err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {...m, pending: false, content: `${m.content}\n\n[failed: network]`}
            : m,
        ),
      );
    } finally {
      setSendBusy(false);
    }
  }

  function appendFiles(incoming: FileList | File[] | null): string | null {
    if (!incoming) return null;
    const incomingArr = Array.from(incoming);
    if (!incomingArr.length) return null;
    const next = [...composerFiles];
    for (const f of incomingArr) {
      if (next.length >= MAX_FILES) return `Max ${MAX_FILES} files per message.`;
      if (f.size > MAX_PER_FILE_BYTES) return `${f.name}: over the 8 MB limit.`;
      const total = next.reduce((s, x) => s + x.size, 0) + f.size;
      if (total > MAX_TOTAL_BYTES) return 'Total attachment size over 24 MB.';
      if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
      next.push(f);
    }
    setComposerFiles(next);
    return null;
  }

  function removeComposerFile(i: number) {
    setComposerFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (mode !== 'live' || closed) return;
    e.preventDefault();
    setDropActive(true);
  }
  function onDragLeave() {
    setDropActive(false);
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDropActive(false);
    if (mode !== 'live' || closed) return;
    const err = appendFiles(e.dataTransfer.files);
    if (err) setError(err);
    else if (error) setError(null);
  }

  const hasMessages = messages.length > 0;
  const visibleReplies = useMemo(
    () => messages.filter((m) => m.role === 'helper').length,
    [messages],
  );
  const status = closed ? 'resolved' : ticket.status;

  const sidebar =
    mode === 'live' && !embedded ? (
      <SupportThreadSidebar
        ticket={ticket}
        visibleReplies={visibleReplies}
        pendingReplies={pendingReplies}
      />
    ) : null;

  const main = (
    <section
      aria-label="Support ticket"
      className="support-thread"
      data-variant="bubbles"
      style={embedded ? {height: '100%', maxHeight: 'none', border: 'none', borderRadius: 0} : undefined}
    >
      <header className="support-thread-head">
        <div className="support-thread-head-meta">
          <div className="od-eyebrow-row">
            <StatusBadge status={status} />
            <span className="od-id">#{ticket.pid}</span>
          </div>
          <h1>{ticket.subject || 'Support ticket'}</h1>
        </div>
        <div className="support-thread-head-actions">
          {mode === 'live' && !closed && onEnd ? (
            <button
              type="button"
              className="od-btn od-btn-danger od-btn-sm"
              onClick={onEnd}
            >
              End ticket
            </button>
          ) : null}
        </div>
      </header>

      <div
        ref={logRef}
        className="support-thread-log"
        data-dropzone-active={dropActive ? 'true' : 'false'}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        aria-live="polite"
        aria-label="Message thread"
      >
        {!hasMessages ? (
          <div className="support-thread-empty">
            <div className="od-icon-big" aria-hidden="true">
              ⌗
            </div>
            <h3>Relayed to the OpenDrone Discord.</h3>
            <p>
              A bot posted your message as a private thread in our Discord
              server, where all project communication happens. Replies
              usually land within a few hours (CET). We&rsquo;ll email you
              the moment a moderator confirms an answer, so you don&rsquo;t
              need to keep this tab open.
            </p>
          </div>
        ) : (
          <>
            <DaySeparator iso={messages[0].createdAt} />
            {messages.map((m, i) => (
              <ThreadMessageView
                key={m.id}
                message={m}
                showAvatarOf={
                  i === 0 || messages[i - 1].isSelf !== m.isSelf
                }
              />
            ))}
          </>
        )}
        <div className="support-dropzone-overlay">↓ Drop files to attach</div>
      </div>

      {mode === 'live' && !closed ? (
        <form
          className="support-composer"
          onSubmit={(e) => {
            void handleSend(e);
          }}
        >
          <div className="support-composer-row">
            <label className="sr-only" htmlFor={composerId}>
              Reply to ticket
            </label>
            <textarea
              id={composerId}
              ref={composerRef}
              className="support-composer-textarea"
              rows={1}
              placeholder="Type a reply…  ⌘ + Enter to send"
              value={draft}
              maxLength={1800}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
                }
              }}
              disabled={sendBusy}
              aria-label="Reply to ticket"
            />
            <div className="support-composer-actions">
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
                className="od-btn-icon"
                aria-label="Attach file"
                onClick={() => fileInputRef.current?.click()}
                disabled={sendBusy || composerFiles.length >= MAX_FILES}
              >
                <Paperclip size={15} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button
                type="submit"
                className="od-btn od-btn-primary od-btn-sm"
                aria-label="Send reply"
                disabled={sendBusy || (!draft.trim() && !composerFiles.length)}
              >
                {sendBusy ? 'Sending…' : 'Send →'}
              </button>
            </div>
          </div>
          {composerFiles.length ? (
            <div className="support-attach-strip" aria-label="Files to send">
              {composerFiles.map((f, i) => (
                <ComposerChip
                  key={`${f.name}-${i}`}
                  file={f}
                  onRemove={() => removeComposerFile(i)}
                />
              ))}
            </div>
          ) : null}
          {error ? (
            <p className="support-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="support-composer-hint">
            <kbd>⌘</kbd> + <kbd>Enter</kbd> to send · drag files anywhere to
            attach
          </div>
        </form>
      ) : null}

      {closed ? (
        <div
          className="support-composer-hint"
          style={{padding: '14px 22px', borderTop: '1.5px solid var(--od-line-strong)'}}
        >
          This ticket is closed. Open a new one if you need more help.
        </div>
      ) : null}
    </section>
  );

  // Embedded inside /account/support detail pane → no sidebar, just the
  // main column. Otherwise wrap main + sidebar in the layout grid.
  if (embedded || !sidebar) return main;
  return (
    <div className="support-active-layout">
      {sidebar}
      {main}
    </div>
  );
}

function SupportThreadSidebar({
  ticket,
  visibleReplies,
  pendingReplies,
}: {
  ticket: SupportThreadInitial;
  visibleReplies: number;
  pendingReplies: number;
}) {
  const opened = ticket.openedAt
    ? new Date(ticket.openedAt * 1000).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  return (
    <aside className="support-sidebar" aria-label="Ticket details">
      <section className="support-sidebar-card">
        <p className="od-tile-eyebrow">→ TICKET DETAILS</p>
        <dl className="support-sidebar-rows">
          <div className="support-sidebar-row">
            <dt>Ticket</dt>
            <dd className="support-sidebar-mono">#{ticket.pid || '·'}</dd>
          </div>
          {opened ? (
            <div className="support-sidebar-row">
              <dt>Opened</dt>
              <dd className="support-sidebar-mono">{opened}</dd>
            </div>
          ) : null}
          {ticket.product ? (
            <div className="support-sidebar-row">
              <dt>Product</dt>
              <dd>{ticket.product}</dd>
            </div>
          ) : null}
          {ticket.firmware ? (
            <div className="support-sidebar-row">
              <dt>Firmware</dt>
              <dd className="support-sidebar-mono">{ticket.firmware}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="support-sidebar-card">
        <p className="od-tile-eyebrow">⌘ REPLIES</p>
        <div className="support-sidebar-counts">
          <div className="support-sidebar-count">
            <span className="support-sidebar-count-num">{visibleReplies}</span>
            <span className="support-sidebar-count-label">visible</span>
          </div>
          <div className="support-sidebar-count">
            <span className="support-sidebar-count-num">{pendingReplies}</span>
            <span className="support-sidebar-count-label">
              awaiting confirmation
            </span>
          </div>
        </div>
        <p className="support-sidebar-help">
          Replies are typed in the OpenDrone Discord and relayed here by
          the bot.
        </p>
        {pendingReplies > 0 ? (
          <p className="support-sidebar-help">
            A moderator reviews replies before they appear here.
          </p>
        ) : null}
      </section>

      <section className="support-sidebar-card support-sidebar-faq">
        <p className="od-tile-eyebrow">↗ WHILE YOU WAIT</p>
        <ul className="support-sidebar-links">
          <li>
            <a href={DISCORD_INVITE_URL} target="_blank" rel="noreferrer noopener">
              Search the Discord first; someone may have asked already →
            </a>
          </li>
          <li>
            <a href="/newsletter" target="_blank" rel="noreferrer noopener">
              Latest engineering notes →
            </a>
          </li>
          <li>
            <a href="/firmware-partners" target="_blank" rel="noreferrer noopener">
              Firmware partner docs →
            </a>
          </li>
        </ul>
      </section>
    </aside>
  );
}

function StatusBadge({status}: {status: SupportThreadInitial['status']}) {
  const map: Record<
    SupportThreadInitial['status'],
    {cls: string; label: string}
  > = {
    open: {cls: 'is-open', label: 'Open'},
    awaiting: {cls: 'is-awaiting', label: 'Awaiting your reply'},
    progress: {cls: 'is-progress', label: 'In progress'},
    resolved: {cls: 'is-resolved', label: 'Resolved'},
  };
  const m = map[status] ?? map.open;
  return (
    <span className={`od-status ${m.cls}`} role="status">
      {m.label}
    </span>
  );
}

function DaySeparator({iso}: {iso: string}) {
  const label = useMemo(() => {
    try {
      const d = new Date(iso);
      const today = new Date();
      const isToday = d.toDateString() === today.toDateString();
      const fmt = d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      return isToday ? `Today, ${fmt}` : fmt;
    } catch {
      return '';
    }
  }, [iso]);
  if (!label) return null;
  return (
    <div className="support-thread-day" aria-hidden="true">
      {label}
    </div>
  );
}

function ThreadMessageView({
  message,
  showAvatarOf,
}: {
  message: LocalMessage;
  showAvatarOf: boolean;
}) {
  const sideCls = message.isSelf ? 'is-user' : 'is-staff';
  const initial = (message.firstName?.[0] ?? '?').toUpperCase();
  const time = formatTime(message.createdAt);
  const role = message.isSelf ? 'You' : 'Staff';
  return (
    <article
      className={`support-msg ${sideCls} ${message.pending ? 'support-msg-pending' : ''}`}
    >
      <div
        className="support-msg-avatar"
        aria-hidden="true"
        style={showAvatarOf ? undefined : {visibility: 'hidden'}}
      >
        {initial}
      </div>
      <div className="support-msg-body">
        <div className="support-msg-meta">
          <span className="od-author">{message.firstName}</span>
          <span className="od-role">{role}</span>
          <span className="od-time">{time}</span>
        </div>
        {message.content ? (
          <div className="support-msg-bubble">{message.content}</div>
        ) : null}
        <Attachments items={message.attachments} />
      </div>
    </article>
  );
}

function Attachments({
  items,
}: {
  items: Array<{url: string; filename: string}>;
}) {
  if (!items?.length) return null;
  return (
    <div className="support-msg-attachments">
      {items.map((a, i) => {
        const ext = a.filename.split('.').pop()?.toLowerCase() ?? '';
        const isImage = IMAGE_EXT.has(ext);
        const isVideo = VIDEO_EXT.has(ext);
        const isAudio = AUDIO_EXT.has(ext);
        const key = `${a.filename}-${i}`;

        if (!a.url) {
          return (
            <span
              key={key}
              className="support-msg-file is-pending"
              aria-label={`Pending: ${a.filename}`}
            >
              <span className="od-icon" aria-hidden="true">
                <FileTypeIcon ext={ext} />
              </span>
              <span className="support-msg-file-name">{a.filename}</span>
            </span>
          );
        }
        if (isImage) {
          return (
            <a
              key={key}
              className="support-msg-image"
              href={a.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open image ${a.filename}`}
              title={a.filename}
            >
              <img src={a.url} alt={a.filename} loading="lazy" decoding="async" />
            </a>
          );
        }
        if (isVideo) {
          return (
            <div key={key} className="support-msg-video">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                controls
                preload="metadata"
                src={a.url}
                aria-label={a.filename}
              />
              <a
                className="support-msg-video-name"
                href={a.url}
                target="_blank"
                rel="noreferrer noopener"
                download
              >
                {a.filename}
              </a>
            </div>
          );
        }
        if (isAudio) {
          return (
            <div key={key} className="support-msg-audio">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls preload="metadata" src={a.url} aria-label={a.filename} />
              <a
                className="support-msg-file-name"
                href={a.url}
                target="_blank"
                rel="noreferrer noopener"
                download
              >
                {a.filename}
              </a>
            </div>
          );
        }
        return (
          <a
            key={key}
            className="support-msg-file"
            href={a.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Download ${a.filename}`}
            download
          >
            <span className="od-icon" aria-hidden="true">
              <FileTypeIcon ext={ext} />
            </span>
            <span className="support-msg-file-name">{a.filename}</span>
          </a>
        );
      })}
    </div>
  );
}

function ComposerChip({
  file,
  onRemove,
}: {
  file: File;
  onRemove: () => void;
}) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isImage = IMAGE_EXT.has(ext);
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
      <span className="inline-flex items-center gap-1">
        <Paperclip size={12} strokeWidth={1.75} aria-hidden="true" />
        {file.name}
      </span>
      <span className="od-help" style={{fontSize: '10px'}}>
        {formatBytes(file.size)}
      </span>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  } catch {
    return '';
  }
}

function mergeMessages(
  existing: LocalMessage[],
  incoming: ThreadMessage[],
): LocalMessage[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.map((m) => m.id));
  // Also dedupe optimistic local-* messages whose content matches a
  // newly-arrived self-relayed message within a short time window.
  const additions: LocalMessage[] = [];
  for (const m of incoming) {
    if (seen.has(m.id)) continue;
    if (m.role === 'self') {
      const pendingMatch = existing.find(
        (e) =>
          e.id.startsWith('local-') &&
          e.role === 'self' &&
          e.content === m.content &&
          Math.abs(
            new Date(e.createdAt).getTime() - new Date(m.createdAt).getTime(),
          ) < 60_000,
      );
      if (pendingMatch) continue;
    }
    additions.push({...m, isSelf: m.role === 'self'});
  }
  if (!additions.length) return existing;
  // Drop any local optimistic messages that the server has now confirmed
  // (matched pair: same content within 60s window).
  const filtered = existing.filter((e) => {
    if (!e.id.startsWith('local-')) return true;
    if (e.role !== 'self') return true;
    const realised = incoming.find(
      (m) =>
        m.role === 'self' &&
        m.content === e.content &&
        Math.abs(
          new Date(m.createdAt).getTime() - new Date(e.createdAt).getTime(),
        ) < 60_000,
    );
    return !realised;
  });
  const merged = [...filtered, ...additions];
  merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return merged;
}

// Convenience initial-fetch wrapper for the live mode. Returns parent
// loader-friendly shape - kept here so /support and /account/support
// share one fetch.
export async function fetchActiveTicketStatus(): Promise<StatusResponse | null> {
  try {
    const res = await fetch('/api/support/status', {credentials: 'same-origin'});
    return (await res.json()) as StatusResponse;
  } catch {
    return null;
  }
}
