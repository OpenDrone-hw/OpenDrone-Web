import {useEffect, useRef, useState} from 'react';
import {trackEvent} from '~/lib/growth/plausible';

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
export function ChatFpvWidget({src}: {src: string | null | undefined}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [lift, setLift] = useState(0);

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
            width: 'min(400px, calc(100vw - 32px))',
            height: `min(600px, calc(100vh - ${96 + lift}px))`,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
            background: '#0b0d10',
          }}
        >
          <iframe
            src={src}
            title="ChatFPV, an AI assistant for FPV and OpenDrone"
            style={{width: '100%', height: '100%', border: 0}}
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        </div>
      ) : null}
      <button
        ref={button}
        type="button"
        className="od-btn od-btn-primary"
        aria-expanded={open}
        onClick={() =>
          setOpen((v) => {
            if (!v) trackEvent('chatfpv_widget_open', {props: {surface: 'widget'}});
            return !v;
          })
        }
      >
        {open ? 'Close ChatFPV' : 'Ask ChatFPV (AI)'}
      </button>
    </div>
  );
}
