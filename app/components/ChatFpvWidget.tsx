import {useEffect, useRef, useState} from 'react';
import {trackEvent} from '~/lib/growth/plausible';
import {copyText} from '~/lib/copy';

const PRIVACY_NOTICE_FALLBACK =
  "Your question and the product on this page go straight to ChatFPV, Incutec's AI assistant, exactly as you type it: please do not include your name, email, phone or order number. Conversations that do not become a ticket are deleted after 90 days idle.";
const NOTICE_SUMMARY_FALLBACK = 'AI assistant. How your question is used.';

/**
 * The ChatFPV widget on product and preorder pages: a button that opens
 * ChatFPV's own /embed page in an iframe. No third-party script runs on
 * the page; the iframe loads only after the click. `src` comes from the
 * loader (chatfpv.ts `chatFpvWidgetSrc`) and is null while
 * CHATFPV_WIDGET_ENABLED is not "1", which renders nothing. The page CSP
 * allows the ChatFPV origin in frame-src only while the flag is on
 * (app/lib/csp.ts `chatFpvFrameSrc`).
 *
 * The product page's buy column sits on the right above 960px
 * (`.product-hero` grid breakpoint, `app.css`), the same width the pinned
 * buy bar switches from a bottom strip to a top pill at
 * (`.buy-rail.is-pinned`). Above that width the widget anchors bottom-LEFT
 * instead of bottom-right, so its panel never sits over the buy column
 * regardless of scroll position or page length (storefront-launch
 * iteration 3 audit: a bottom-right panel covered the Pre-order button and
 * prices on desktop). Below it, the widget stays bottom-right and lifts
 * above whichever bottom-of-screen element it would otherwise cover: the
 * pinned mobile buy rail once scrolled that far, or the in-flow buy button
 * (`.product-form`) and ship-promise line ("Delivered by ...", `.ship-line`
 * from `ShipChip.tsx`'s `<ShipLine>` on a preorder/campaign product, or the
 * plain `.product-buy-ship` / `.product-buy-stock` paragraph other statuses
 * use) on first load before any scroll (iteration 3 audit: the closed
 * button covered the ship line on phone; iteration 4: a fix that lifted
 * only above the ship line left an 11px gap to the buy button above it,
 * which the 44px button then covered instead, so `.product-form` is
 * included too, clearing whichever of the two is higher on the page).
 * Closed, the widget is only the button: the data-use disclosure lives
 * inside the open panel, as a one-line strip above the iframe with a
 * details toggle for the full text, so it is never floating over the page
 * or the buy rail before the visitor has opened the panel (iteration 2
 * audit: the previous closed-state notice covered the buy rail on phone and
 * floated with no container on desktop dark).
 */
const WIDE_QUERY = '(min-width: 960px)';
/** Elements near the bottom of the screen the closed button or panel must
 *  not cover, checked only below `WIDE_QUERY` (above it the widget moves to
 *  the left, clear of the buy column entirely). */
const BOTTOM_OBSTACLES = [
  '.buy-rail.is-pinned.is-mobile:not(.is-suppressed)',
  '.product-form',
  '.ship-line',
  '.product-buy-ship',
  '.product-buy-stock',
];
/** An obstacle only counts once its bottom edge is within this many pixels
 *  of the viewport bottom: close enough to reach where the fixed button
 *  (roughly 44-60px tall, 16px from the edge) actually sits. Elements
 *  scrolled higher up the page are ignored so the button is not lifted for
 *  no reason. */
const OBSTACLE_ZONE_PX = 140;
/** How long the panel waits for the iframe's `load` event before it shows
 *  "not responding" instead of a silent black rectangle (baseline iteration
 *  1: the panel was solid black at 150 ms on every open, indistinguishable
 *  from a crash). */
const LOAD_TIMEOUT_MS = 8000;

export function ChatFpvWidget({src}: {src: string | null | undefined}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [lift, setLift] = useState(0);
  const [wide, setWide] = useState(false);

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
    const mql = window.matchMedia(WIDE_QUERY);
    setWide(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!src || wide) {
      setLift(0);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      let top = window.innerHeight;
      for (const selector of BOTTOM_OBSTACLES) {
        for (const el of document.querySelectorAll<HTMLElement>(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue; // off-screen
          if (rect.bottom < window.innerHeight - OBSTACLE_ZONE_PX) continue; // not near the bottom
          top = Math.min(top, rect.top);
        }
      }
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
  }, [src, wide]);

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
    <div
      className="chatfpv-widget"
      style={{
        position: 'fixed',
        ...(wide ? {left: 16, right: 'auto'} : {right: 16, left: 'auto'}),
        bottom: 16 + lift,
        zIndex: 61,
        display: 'flex',
        flexDirection: 'column',
        alignItems: wide ? 'flex-start' : 'flex-end',
        gap: 8,
      }}
    >
      {open ? (
        <div
          role="dialog"
          aria-label="Ask ChatFPV (AI)"
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            width: 'min(400px, calc(100vw - 32px))',
            height: `min(600px, calc(100vh - ${96 + lift}px))`,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
            background: '#0b0d10',
          }}
        >
          {/* One line, always visible while the panel is open (before the
              first question, and through the loading and timeout states):
              the EU AI Act Art. 50 disclosure belongs at the moment of use,
              not floating over the page before the panel ever opens
              (storefront-launch iteration 2 audit: the closed-state notice
              covered the buy rail on phone and floated with no container on
              desktop dark). Closed, the widget shows only the button, same
              as main. */}
          <details
            className="chatfpv-widget-notice"
            style={{flex: '0 0 auto', background: '#14171c', color: '#e8e8e8', borderBottom: '1px solid rgba(255,255,255,0.08)'}}
          >
            <summary style={{padding: '6px 10px', fontSize: 12, lineHeight: 1.4, cursor: 'pointer', listStyle: 'none'}}>
              {copyText('chrome.chatfpv_widget_notice_summary') ?? NOTICE_SUMMARY_FALLBACK}
            </summary>
            <p className="sp-hint" style={{margin: 0, padding: '0 10px 8px', fontSize: 12, lineHeight: 1.4}}>
              {copyText('chrome.chatfpv_widget_privacy_notice') ?? PRIVACY_NOTICE_FALLBACK}
            </p>
          </details>
          <div style={{position: 'relative', flex: '1 1 auto', minHeight: 0}}>
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
        </div>
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
