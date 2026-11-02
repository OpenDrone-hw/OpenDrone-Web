/** Shared status text and step layout for the /flash page. Text first: colour is only a second cue. */

import {useEffect, useRef, useState} from 'react';
import {stagingBenchEnabled} from '../staging.ts';

export type Status =
  | {kind: 'idle'}
  | {kind: 'busy'; text: string}
  | {kind: 'ok'; text: string}
  | {kind: 'error'; text: string};

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Only for device-picker errors: there NotFoundError means "nothing chosen". Elsewhere it means unplugged (R4). */
export function pickerErrText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotFoundError') return 'No device was selected.';
  return errText(e);
}

/**
 * Whether the staging bench switch is on, read after mount so the server
 * render and the first client render agree (the server has no window, so it is
 * always false there). Display only: the write gates call stagingBenchEnabled()
 * themselves.
 */
export function useStagingBench(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(stagingBenchEnabled()), []);
  return on;
}

/** Red notice at the top of /flash on a staging bench build. Icon + text + role=alert, error token; renders nothing otherwise. */
export function StagingBenchNotice() {
  if (!useStagingBench()) return null;
  return (
    <div
      role="alert"
      className="mt-4 border-2 border-[var(--color-error)] bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] p-4"
    >
      <p className="flex items-center gap-2 text-[18px] font-bold text-[var(--color-text)]">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="var(--color-error)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 2 21h20L12 3Z" />
          <path d="M12 10v5M12 18v.5" />
        </svg>
        <span>UNVERIFIED BENCH BUILD, may need DFU/SWD recovery</span>
      </p>
      <p className="mt-1 text-[15px]">Staging only. Flashing here is for bench testing with the bench sheet.</p>
    </div>
  );
}

export function StatusLine({status}: {status: Status}) {
  if (status.kind === 'idle') return null;
  const label = {busy: 'Working', ok: 'Done', error: 'Problem'}[status.kind];
  return (
    <p
      role={status.kind === 'error' ? 'alert' : undefined}
      className={`mt-3 text-[15px] ${status.kind === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text)]'}`}
    >
      <strong>{label}:</strong> {status.text}
    </p>
  );
}

export function Step({
  id,
  n,
  title,
  open,
  children,
}: {
  id: string;
  n: number;
  title: string;
  open: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) ref.current?.focus();
    wasOpen.current = open;
  }, [open]);
  return (
    <section className="mt-10" aria-labelledby={`${id}-step-${n}`}>
      <h2 id={`${id}-step-${n}`} ref={ref} tabIndex={-1} className="text-[20px] font-semibold">
        Step {n}. {title}
        {!open ? <span className="sr-only"> (not available yet)</span> : null}
      </h2>
      {open ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

/** Lists why a direct write is blocked. Never offers an override. */
export function BlockedReasons({title, reasons}: {title: string; reasons: string[]}) {
  if (!reasons.length) return null;
  return (
    <div className="mt-3 text-[15px]">
      <p>
        <strong>{title}</strong>
      </p>
      <ul className="mt-1 list-disc pl-6">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

export function saveBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {type: 'application/octet-stream'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function useBeforeUnloadWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);
}
