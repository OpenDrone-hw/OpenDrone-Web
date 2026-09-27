import {useEffect, useRef, useState} from 'react';
import {trackEvent} from '~/lib/growth/plausible';
import {copyText} from '~/lib/copy';

const PRIVACY_NOTICE_FALLBACK =
  "Your question and this page's product go to ChatFPV, Incutec's AI assistant. Your name, email, phone and order numbers are removed first; idle conversations are deleted after 90 days.";

/**
 * The ChatFPV widget on product and preorder pages: a button that opens
 * ChatFPV's own /embed page in an iframe. No third-party script runs on
 * the page; the iframe loads only after the click. `src` comes from the
 * loader (chatfpv.ts `chatFpvWidgetSrc`) and is null while
 * CHATFPV_WIDGET_ENABLED is not "1", which renders nothing. The page CSP
 * allows the ChatFPV origin in frame-src only while the flag is on
 * (app/lib/csp.ts `chatFpvFrameSrc`).
 *
 * On phones the product page pins its buy rail to the bottom edge
 * (`.buy-rail.is-pinned.is-mobile`, portaled to <body>); the widget sits
 * above it so neither covers the other.
 */
const RAIL = '.buy-rail.is-pinned.is-mobile:not(.is-suppressed)';
/** How long the panel waits for the iframe's `load` event before it shows
 *  "not responding" instead of a silent black rectangle (baseline iteration
 *  1: the panel was solid black at 150 ms on every open, indistinguishable
 *  from a crash). */
const LOAD_TIMEOUT_MS = 8000;

export function ChatFpvWidget({src}: {src: string | null | undefined}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [lift, setLift] = useState(0);

  // Reset per open, so a second open re-arms the timeout and the loading
  // state instead of keeping a stale "not responding" from an earlier try.
  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!src) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rail = document.querySelector<HTMLElement>(RAIL);
      const top = rail ? rail.getBoundingClientRect().top : window.innerHeight;
      setLift(Math.max(0, Math.round(window.innerHeight - top)));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // The rail rises in over 0.2 s: measure again once it settled.
    const timers: number[] = [];
    const changed = () => {
      schedule();
      timers.push(window.setTimeout(schedule, 250));
    };
    measure();
    window.addEventListener('scroll', schedule, {passive: true});
    window.addEventListener('resize', schedule);
    const watcher = new MutationObserver(changed);
    watcher.observe(document.body, {childList: true});
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      watcher.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
      if (frame) cancelAnimationFrame(frame);
    };
  }, [src]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!src) return null;
  return (
    <div className="chatfpv-widget" style={{position: 'fixed', right: 16, bottom: 16 + lift, zIndex: 61, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8}}>
      {open ? (
        <div
          role="dialog"
          aria-label="Ask ChatFPV (AI)"
          style={{
            position: 'relative',
            width: 'min(400px, calc(100vw - 32px))',
            height: `min(600px, calc(100vh - ${96 + lift}px))`,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
            background: '#0b0d10',
          }}
        >
          {!loaded ? (
            <div
              role="status"
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                padding: 24,
                textAlign: 'center',
                color: '#e8e8e8',
              }}
            >
              {timedOut ? (
                <>
                  <p style={{margin: 0}}>ChatFPV is not responding.</p>
                  <a href="/support?ticket=1" className="od-btn od-btn-secondary">
                    Open a ticket instead
                  </a>
                </>
              ) : (
                <p style={{margin: 0}} aria-live="polite">
                  Loading ChatFPV…
                </p>
              )}
            </div>
          ) : null}
          <iframe
            src={src}
            title="ChatFPV, an AI assistant for FPV and OpenDrone"
            onLoad={() => setLoaded(true)}
            style={{width: '100%', height: '100%', border: 0, display: loaded ? 'block' : 'none'}}
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        </div>
      ) : null}
      {!everOpened ? (
        <p
          className="sp-hint"
          style={{
            maxWidth: 220,
            margin: 0,
            padding: '6px 10px',
            borderRadius: 8,
            background: 'rgba(11, 13, 16, 0.85)',
            color: '#e8e8e8',
            textAlign: 'right',
          }}
        >
          {copyText('chrome.chatfpv_widget_privacy_notice') ?? PRIVACY_NOTICE_FALLBACK}
        </p>
      ) : null}
      <button
        ref={button}
        type="button"
        className="od-btn od-btn-primary"
        aria-expanded={open}
        onClick={() =>
          setOpen((v) => {
            if (!v) {
              trackEvent('chatfpv_widget_open', {props: {surface: 'widget'}});
              setEverOpened(true);
            }
            return !v;
          })
        }
      >
        {open ? 'Close ChatFPV' : 'Ask ChatFPV (AI)'}
      </button>
    </div>
  );
}
