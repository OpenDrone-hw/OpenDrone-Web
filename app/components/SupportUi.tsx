import {useEffect, useId, useRef, useState} from 'react';
import {Check, Copy, Paperclip, X} from 'lucide-react';
import {copyText} from '~/lib/copy';
import {getActiveTheme} from '~/lib/theme';
import {ACCEPT, checkFiles, formatBytes, MAX_FILES} from '~/lib/support/uploads';
import type {TicketStatus} from '~/lib/support/store';

/**
 * Building blocks shared by the support pages: status pill, time stamp,
 * file picker, Turnstile box and the copyable private link. Words come from
 * `content/copy/support.json`.
 */

export function fill(template: string | undefined, vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), template ?? '');
}

const t = (key: string, vars: Record<string, string> = {}) => fill(copyText(`support.${key}`), vars);

export function StatusPill({status}: {status: TicketStatus}) {
  return (
    <span className={`sp-status sp-status-${status}`}>
      <span className="sp-status-dot" aria-hidden="true" />
      {t(`status_${status}`)}
    </span>
  );
}

// A fixed zone keeps server and browser rendering the same string.
const DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/Brussels', day: 'numeric', month: 'short', year: 'numeric'});

export function Stamp({at, day = false}: {at: number; day?: boolean}) {
  return <time dateTime={new Date(at).toISOString()}>{(day ? DAY : DATE).format(at)}</time>;
}

/**
 * File input with a visible list, checked against the same limits as the
 * server before anything uploads. The real <input type=file> carries the
 * files, so the form works as a plain multipart POST.
 */
export function FilePicker({name = 'files', disabled = false, compact = false}: {name?: string; disabled?: boolean; compact?: boolean}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const hintId = useId();

  function sync(next: File[]) {
    const dt = new DataTransfer();
    next.forEach((f) => dt.items.add(f));
    if (inputRef.current) inputRef.current.files = dt.files;
    setFiles(next);
    const p = checkFiles(next.map((f) => ({name: f.name, size: f.size, type: f.type})));
    setProblem(p ? t(`file_${p.problem}`, {file: p.file ?? ''}) : null);
    inputRef.current?.setCustomValidity(p ? t(`file_${p.problem}`, {file: p.file ?? ''}) : '');
  }

  // A form reset (after a sent reply) empties the input; mirror it.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const onReset = () => {
      setFiles([]);
      setProblem(null);
    };
    form.addEventListener('reset', onReset);
    return () => form.removeEventListener('reset', onReset);
  }, []);

  return (
    <div className={`sp-files${compact ? ' sp-files-compact' : ''}`}>
      <label className="sp-files-add od-btn od-btn-secondary od-btn-sm" aria-disabled={disabled || files.length >= MAX_FILES}>
        <Paperclip size={14} aria-hidden="true" />
        {t('files_add')}
        <input
          ref={inputRef}
          type="file"
          name={name}
          multiple
          accept={ACCEPT}
          disabled={disabled}
          aria-describedby={hintId}
          className="sp-visually-hidden"
          onChange={(e) => sync([...files, ...Array.from(e.currentTarget.files ?? [])].slice(0, MAX_FILES + 1))}
        />
      </label>
      {compact ? null : (
        <p id={hintId} className="sp-hint">
          {t('files_hint')}
        </p>
      )}
      {files.length ? (
        <ul className="sp-file-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${f.lastModified}`} className="sp-file-chip">
              <span className="sp-file-name">{f.name}</span>
              <span className="sp-file-size">{formatBytes(f.size)}</span>
              <button
                type="button"
                className="sp-file-remove"
                aria-label={t('files_remove', {file: f.name})}
                onClick={() => sync(files.filter((_, j) => j !== i))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p role="alert" className="sp-error">
          {problem}
        </p>
      ) : null}
      {compact ? (
        <span id={hintId} className="sp-visually-hidden">
          {t('files_hint')}
        </span>
      ) : null}
    </div>
  );
}

type TurnstileApi = {
  render: (el: HTMLElement, opts: {sitekey: string; theme?: string; size?: string}) => string | undefined;
  reset: (id?: string) => void;
};

/**
 * Cloudflare Turnstile, loaded when the form is first touched. The widget
 * writes `cf-turnstile-response` into the form. `resetKey` changes after
 * every server answer, because a token is single-use.
 */
export function TurnstileBox({siteKey, active, resetKey}: {siteKey: string | null; active: boolean; resetKey: unknown}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !siteKey) return;
    const api = () => (window as unknown as {turnstile?: TurnstileApi}).turnstile;
    const render = () => {
      const cf = api();
      if (!cf || !box.current || widget.current) return;
      widget.current = cf.render(box.current, {sitekey: siteKey, theme: getActiveTheme(), size: 'flexible'}) ?? null;
    };
    if (api()) return render();
    const id = 'cf-turnstile-script';
    if (!document.getElementById(id)) {
      const s = document.createElement('script');
      s.id = id;
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    }
    const timer = window.setInterval(() => {
      if (api()) {
        window.clearInterval(timer);
        render();
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, [active, siteKey]);

  useEffect(() => {
    const cf = (window as unknown as {turnstile?: TurnstileApi}).turnstile;
    if (cf && widget.current) cf.reset(widget.current);
  }, [resetKey]);

  if (!siteKey) return null;
  return <div ref={box} className="sp-turnstile" />;
}

export function CopyLink({url}: {url: string}) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      document.execCommand?.('copy');
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2400);
  }

  return (
    <div className="sp-copy">
      <span id={labelId} className="sp-visually-hidden">
        {t('link_title')}
      </span>
      <input
        ref={inputRef}
        className="sp-copy-input"
        readOnly
        value={url}
        aria-labelledby={labelId}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="od-btn od-btn-primary od-btn-sm sp-copy-btn" onClick={() => void copy()}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        <span aria-live="polite">{copied ? t('copied') : t('copy')}</span>
      </button>
    </div>
  );
}
