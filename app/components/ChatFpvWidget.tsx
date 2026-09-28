import {useEffect, useRef, useState} from 'react';
import {useRouteLoaderData} from 'react-router';
import {trackEvent} from '~/lib/growth/plausible';
import {copyText} from '~/lib/copy';
import {handoffPlacement, takeHandoffTicket, withHandoffTicket, type HandoffPlacement} from '~/lib/accounts/handoff';
import {fetchWidgetAssertion, postAssertion, refreshDelayMs} from '~/lib/accounts/widget-client';

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
 * On phones the product page pins its buy rail to the bottom edge
 * (`.buy-rail.is-pinned.is-mobile`, portaled to <body>); the widget also
 * clears the in-flow buy button (`.product-form`) and the ship-promise line
 * (`.ship-line` / `.product-buy-ship` / `.product-buy-stock`) before any
 * scroll, and the pinned rail once scrolled that far (storefront-launch
 * iteration 3/4 audit: a narrower obstacle list left the closed button
 * sitting on top of the Pre-order button and the price-step/progress bar on
 * `/products/openesc` and `/products/openrx`). Closed, the widget is only
 * the button: the data-use disclosure lives inside the open panel, as a
 * one-line strip above the iframe with a details toggle for the full text,
 * so it is never floating over the page or the buy rail before the visitor
 * has opened the panel (iteration 2 audit: the previous closed-state notice
 * covered the buy rail on phone and floated with no container on desktop
 * dark).
 *
 * The open panel also never covers the site header: its height is capped to
 * the live gap between the header pill's actual bottom edge (measured, not
 * assumed) and the lifted bottom position, on every viewport width, not
 * only phones (iteration 5 audit, `v2/day2/widget/before/report.json`: a
 * fixed 96px top margin undershot the real header at 900px wide, giving a
 * 35px overlap that 1440px and 390px happened not to expose).
 *
 * `handoff` (HANDOFF_ENABLED "1", product pages only): a `#cfh=<ticket>` in
 * the page URL is removed from the address bar and the widget opens with
 * the ticket in the iframe src fragment, where ChatFPV redeems it
 * (app/lib/accounts/handoff.ts). That src stays pinned until the panel
 * closes, so a variant change cannot reload the iframe and redeem twice.
 * The handed-off panel never covers the product column (`PRODUCT_COLUMN`:
 * title, variant options, notify/buy area; morning review 2026-09-28 shot
 * 26: at 1440x900 the right-docked panel sat on the variant buttons). It
 * opens beside the column where `handoffPlacement` finds room (right at
 * 1920, left over the gallery at 1440 and 1024); where there is none (the
 * one-column phone layout) it stays closed and the button shows an unread
 * badge, with the iframe already loaded hidden so the 120 s ticket is
 * redeemed now and the conversation is there on the first tap.
 * ChatFPV's "Continue on chatfpv.com" opens a new tab from inside the
 * iframe: the sandbox allows popups that escape it.
 *
 * Signed in (ACCOUNTS_ENABLED "1", root loader `accountSignedIn`): once the
 * iframe loads, the page fetches /api/account/widget-assertion and posts it
 * to the iframe with the exact ChatFPV origin as targetOrigin, again one
 * minute before each assertion expires. ChatFPV then owns the conversation
 * by account, and its "Continue on chatfpv.com" is a plain /chat/<id> link.
 */
const BOTTOM_OBSTACLES = [
  '.buy-rail.is-pinned.is-mobile:not(.is-suppressed)',
  '.product-form',
  '.ship-line',
  '.product-buy-ship',
  '.product-buy-stock',
  // The notify/newsletter form under a coming-soon product: its consent line sat under the button at 390 px.
  '.newsletter-signup-form',
];
/**
 * Obstacles whose top edge is in the upper third of the viewport are
 * ignored, so a buy form scrolled up the page never pushes the button
 * toward the header. Below that line the button is stacked above every
 * obstacle it overlaps (see `measure`): a single "lift above the lowest
 * obstacle" left it on the Pre-order button on `/products/openesc` at
 * 390px wide, and a vertical-only check lifted it mid-page on desktop,
 * where the buy column sits beside it.
 */
const OBSTACLE_ZONE_FRACTION = 2 / 3;
const HEADER = '.site-header-main';
/** The product page column a handed-off panel must leave uncovered. */
const PRODUCT_COLUMN = '.product-hero-copy, [data-buy-module]';
/** Clear space kept below the header pill's measured bottom edge. */
const HEADER_MARGIN_PX = 16;
/** Panel floor so a very short viewport still gets a usable panel instead
 *  of being squeezed to nothing by the header-clearance cap. */
const MIN_PANEL_HEIGHT_PX = 280;
/** How long the panel waits for the iframe's `load` event before it shows
 *  "not responding" instead of a silent black rectangle (baseline iteration
 *  1: the panel was solid black at 150 ms on every open, indistinguishable
 *  from a crash). */
const LOAD_TIMEOUT_MS = 8000;

export function ChatFpvWidget({src, handoff = false}: {src: string | null | undefined; handoff?: boolean}) {
  const [open, setOpen] = useState(false);
  const [handoffSrc, setHandoffSrc] = useState<string | null>(null);
  const handoffRead = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState(0);
  /** Tallest the panel may be without reaching above the header, given the
   *  current lift. Recomputed alongside `lift` from the same measurement
   *  pass, so it tracks the real header height instead of a guessed
   *  constant. */
  const [maxPanelHeight, setMaxPanelHeight] = useState(600);
  /** Handoff only: where the auto-opened panel sits (null: the default
   *  right-docked panel above the button). */
  const [dock, setDock] = useState<HandoffPlacement>(null);
  /** Handoff with no room beside the product column: the iframe loads
   *  hidden and the button carries an unread badge until it is opened. */
  const [unread, setUnread] = useState(false);
  const [dockHeight, setDockHeight] = useState(600);
  const mounted = open || unread;
  const iframe = useRef<HTMLIFrameElement>(null);
  const root = useRouteLoaderData('root') as {accountSignedIn?: boolean} | undefined;
  const signedIn = Boolean(root?.accountSignedIn);

  // Signed-in shoppers: hand the iframe a fresh assertion while it is loaded.
  useEffect(() => {
    if (!mounted || !loaded || !signedIn || !src) return;
    let timer = 0;
    let stopped = false;
    const push = async () => {
      const got = await fetchWidgetAssertion();
      if (stopped || !got) return;
      postAssertion(iframe.current?.contentWindow ?? null, src, got.assertion);
      timer = window.setTimeout(() => void push(), refreshDelayMs(got.exp));
    };
    void push();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [mounted, loaded, signedIn, src]);

  // Reset per open, so a second open re-arms the timeout and the loading
  // state instead of keeping a stale "not responding" from an earlier try.
  // Keyed on `mounted`, so opening a panel preloaded behind the unread badge
  // keeps its already-loaded iframe.
  useEffect(() => {
    if (!mounted) return;
    setLoaded(false);
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [mounted]);

  // Move focus into the panel on open, and back to the button on close, so
  // keyboard and screen-reader users land on the conversation instead of
  // wherever focus happened to be on the page underneath.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!src) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Stack the button above every buy-area element it would otherwise
      // sit on: start at the viewport bottom, and whenever an obstacle under
      // the button's column overlaps the button's box, move the box above
      // that obstacle and check again (clearing the ship line can land the
      // button on the Pre-order button right above it). An obstacle beside
      // the button (the desktop buy column) or above it never lifts it.
      const rects: DOMRect[] = [];
      for (const selector of BOTTOM_OBSTACLES) {
        for (const el of document.querySelectorAll<HTMLElement>(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue; // off-screen
          if (rect.top < window.innerHeight * (1 - OBSTACLE_ZONE_FRACTION)) continue; // above the lower two-thirds
          rects.push(rect);
        }
      }
      const col = button.current?.getBoundingClientRect();
      const colLeft = col ? col.left : window.innerWidth - 16 - 160;
      const colRight = col ? col.right : window.innerWidth - 16;
      const buttonHeight = col?.height ?? 44;
      let edge = window.innerHeight;
      for (let moved = true; moved; ) {
        moved = false;
        const boxBottom = edge - 16;
        const boxTop = boxBottom - buttonHeight;
        for (const rect of rects) {
          if (rect.right <= colLeft || rect.left >= colRight) continue;
          if (rect.top < boxBottom && rect.bottom > boxTop && rect.top < edge) {
            edge = rect.top;
            moved = true;
          }
        }
      }
      const nextLift = Math.max(0, Math.round(window.innerHeight - edge));
      setLift(nextLift);
      const header = document.querySelector<HTMLElement>(HEADER);
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      // The fixed container is bottom-anchored and sized by its flex
      // content: the panel PLUS the toggle button below it (column layout,
      // 8px gap), not the panel alone. Leaving the button's own height out
      // of this budget pushed the panel's top edge well above where the
      // height alone predicted (iteration 5 audit: computed available=601
      // capped the panel at 600px, but the button+gap added ~52px more,
      // landing the panel's real top 52px higher than intended and
      // reproducing the header overlap the cap was meant to remove).
      const buttonSpace = (button.current?.getBoundingClientRect().height ?? 44) + 8;
      const available = window.innerHeight - Math.max(0, headerBottom) - HEADER_MARGIN_PX - (16 + nextLift + buttonSpace);
      setMaxPanelHeight(Math.max(MIN_PANEL_HEIGHT_PX, Math.min(600, Math.round(available))));
      // A docked handoff panel has no button under it: header gap to the bottom gutter.
      setDockHeight(Math.max(MIN_PANEL_HEIGHT_PX, Math.min(600, Math.round(window.innerHeight - Math.max(0, headerBottom) - HEADER_MARGIN_PX - 16))));
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
    if (!handoff || !src || handoffRead.current) return;
    handoffRead.current = true;
    const ticket = takeHandoffTicket(window);
    if (!ticket) return;
    setHandoffSrc(withHandoffTicket(src, ticket));
    const column = document.querySelector<HTMLElement>(PRODUCT_COLUMN)?.getBoundingClientRect() ?? null;
    const place = handoffPlacement(window.innerWidth, column);
    if (place) {
      setDock(place);
      setOpen(true);
    } else {
      setUnread(true);
    }
  }, [handoff, src]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setHandoffSrc(null);
        setDock(null);
        button.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!src) return null;
  return (
    <div className="chatfpv-widget" style={{position: 'fixed', right: 16, bottom: 16 + lift, zIndex: 61, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8}}>
      {mounted ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Ask ChatFPV (AI)"
          tabIndex={-1}
          hidden={!open}
          style={{
            ...(dock
              ? {position: 'fixed', bottom: 16, [dock.side]: 16, width: dock.width, height: dockHeight}
              : {position: 'relative', width: 'min(400px, calc(100vw - 32px))', height: maxPanelHeight}),
            display: open ? 'flex' : 'none',
            flexDirection: 'column',
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
              ref={iframe}
              src={handoffSrc ?? src}
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
        aria-label={unread && !open ? 'Ask ChatFPV (AI), 1 unread reply' : undefined}
        style={{position: 'relative'}}
        onClick={() => {
          if (open) {
            setHandoffSrc(null);
            setDock(null);
          }
          setUnread(false);
          setOpen((v) => {
            if (!v) {
              trackEvent('chatfpv_widget_open', {props: {surface: 'widget'}});
            }
            return !v;
          });
        }}
      >
        {open ? 'Close ChatFPV' : 'Ask ChatFPV (AI)'}
        {unread && !open ? (
          <span
            className="chatfpv-widget-unread"
            aria-hidden="true"
            style={{position: 'absolute', top: -7, right: -7, minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: '#e5484d', color: '#fff', fontSize: 12, fontWeight: 700, lineHeight: '20px', textAlign: 'center', boxShadow: '0 0 0 2px #0b0d10'}}
          >
            1
          </span>
        ) : null}
      </button>
    </div>
  );
}
