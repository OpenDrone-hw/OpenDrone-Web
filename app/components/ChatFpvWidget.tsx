import {useEffect, useRef, useState} from 'react';
import {useRouteLoaderData} from 'react-router';
import {trackEvent} from '~/lib/growth/plausible';
import {copyText} from '~/lib/copy';
import {handoffPlacement, takeHandoffTicket, withHandoffTicket, type HandoffPlacement} from '~/lib/accounts/handoff';
import {fetchWidgetAssertion, postAssertion, refreshDelayMs} from '~/lib/accounts/widget-client';
import {CHATFPV_OPEN_EVENT, PANEL_ANIM_MS, PHONE_MAX_WIDTH_PX, closedLabel, panelTransformOrigin, toggleHiddenBySheet} from './chatfpv-widget-ui';

const PRIVACY_NOTICE_FALLBACK =
  "Your question and the product on this page go straight to ChatFPV, Incutec's AI assistant, exactly as you type it: please do not include your name, email, phone or order number. Conversations that do not become a ticket are deleted after 90 days idle.";
const NOTICE_SUMMARY_FALLBACK = 'AI assistant. How your question is used.';

/**
 * The ChatFPV widget on product and preorder pages: a button that opens
 * ChatFPV's own /embed page in an iframe. No third-party script runs on
 * the page; the iframe loads only after the click. `src` comes from the
 * loader (chatfpv.ts `chatFpvWidgetSrc`, which also appends `chrome=compact`
 * so /embed hides its own title/badge row - this chrome supplies one
 * instead) and is null while CHATFPV_WIDGET_ENABLED is not "1", which
 * renders nothing. The page CSP allows the ChatFPV origin in frame-src only
 * while the flag is on (app/lib/csp.ts `chatFpvFrameSrc`).
 *
 * At 959px and narrower (phones and the one-column tablet layout) there is no
 * floating launcher at all (audit round 3, A4: every placement landed on a
 * buy control on some phone, and at 768 on the variant options). The same panel opens from
 * the "Ask ChatFPV" entry in the mobile menu and the inline "Questions? Ask
 * ChatFPV" link under the buy box (`ChatFpvEntry.tsx`), both dispatching
 * `CHATFPV_OPEN_EVENT`; closing returns focus to whichever opened it.
 *
 * From 960px up, placement is fixed and predictable: the bottom-right corner, inset by the
 * device safe area (`.chatfpv-widget` in app.css). It never dodges page
 * content. The one exception is the phone product page's sticky buy bar
 * (`BOTTOM_BAR`, portaled to <body>): while it is showing, the launcher sits
 * above it (`lift`). Layering: closed, the launcher is below the mobile
 * menu, the cart drawer and dialogs (z 39 against .overlay 40, header 30..70,
 * cart-added 90); open, it is above the pinned rail (z 61) so the panel is
 * never covered. Both values live in app.css.
 *
 * Closed, the widget is only
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
 *
 * Closed, the launcher is the OpenDrone emblem (`OpenDroneAvatar`, the exact
 * mark OpenDrone/brand ships at `avatar/opendrone-avatar.svg` - never
 * recoloured or restyled) with a small separate "Beta" tag overlapping its
 * top-right corner; the unread badge, when both apply, sits on the
 * top-left corner instead so the two never collide. The accessible name
 * (`closedLabel`) always says "beta" even though the visible tag is tiny.
 * Opening rolls the panel out of the launcher: `.chatfpv-widget-panel`
 * scales up from `transform-origin: bottom right` (the launcher's corner;
 * `panelTransformOrigin` flips it for a left-docked handoff panel, which
 * opens away from the launcher) with a short CSS transition, skipped under
 * `prefers-reduced-motion`. The panel stays mounted `PANEL_ANIM_MS` past
 * `open` going false so the collapse can finish (`closing` below) instead
 * of being cut off; the emblem reappears as a small icon in the panel's own
 * header next to "ChatFPV" and the same Beta tag, so the two states read as
 * one continuous identity. On a phone the panel is a full sheet from just
 * under the site header to the bottom gutter (`sheet`), which rolls up the
 * same way; the round launcher hides itself while that sheet is open
 * (`toggleHiddenBySheet`) since the sheet's own header already has a close,
 * and reappears - focusable again - the instant it closes, so Escape and
 * the header close button still return focus to a real, visible launcher
 * (`app/components/chatfpv-widget-ui.test.ts`).
 */
const BOTTOM_BAR = '.buy-rail.is-pinned.is-mobile:not(.is-suppressed)';
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
  /** Phone-sheet only: top offset (px from the viewport top) so the sheet
   *  starts just under the header, never over it. Recomputed alongside
   *  `maxPanelHeight`/`dockHeight` from the same measurement pass. */
  const [sheetTop, setSheetTop] = useState(96);
  /** `PHONE_MAX_WIDTH_PX` or narrower: the panel becomes a full sheet
   *  instead of a small floating card (a handoff `dock` never happens at
   *  this width - `handoffPlacement` returns null for the one-column phone
   *  layout - so the two never fight over the panel's position). */
  const [isPhone, setIsPhone] = useState(false);
  const mounted = open || unread;
  /** True for `PANEL_ANIM_MS` after `mounted` goes false, so the panel's
   *  roll-back CSS transition (`.chatfpv-widget-panel`, no `.is-open`) gets
   *  to finish instead of the panel leaving the DOM mid-shrink. */
  const [closing, setClosing] = useState(false);
  const panelInDom = mounted || closing;
  /** Drives the `.is-open` class (the roll-out/roll-back CSS transition),
   *  one animation frame behind `open`. A CSS transition only plays on a
   *  style CHANGE to an already-painted element - a freshly mounted node
   *  that already carries its final class on its first paint does not
   *  transition at all, so the panel would otherwise jump straight to full
   *  size with no roll-out. Mounting first at the collapsed style, then
   *  flipping this on the next frame, gives it a real "before" state to
   *  animate from. */
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setExpanded(open));
    return () => cancelAnimationFrame(id);
  }, [open]);
  const iframe = useRef<HTMLIFrameElement>(null);
  /** Element that opened the panel through the menu entry or inline link;
   *  focus returns there on close (the launcher is display:none on phones). */
  const openerRef = useRef<HTMLElement | null>(null);
  const root = useRouteLoaderData('root') as {accountSignedIn?: boolean} | undefined;
  const signedIn = Boolean(root?.accountSignedIn);

  useEffect(() => {
    if (!src || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH_PX}px)`);
    const update = () => setIsPhone(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [src]);

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

  // Keep the panel mounted PANEL_ANIM_MS past `mounted` going false, so its
  // roll-back animation can play, then drop the pinned handoff dock/src -
  // deferred here rather than in `closePanel` so a docked panel does not
  // jump to the default layout mid-shrink.
  useEffect(() => {
    if (mounted) {
      setClosing(false);
      return;
    }
    setClosing(true);
    const t = window.setTimeout(() => {
      setClosing(false);
      setHandoffSrc(null);
      setDock(null);
    }, PANEL_ANIM_MS);
    return () => window.clearTimeout(t);
  }, [mounted]);

  // Move focus into the panel on open, and back to the launcher on close
  // (including when the phone sheet had hidden it - this runs after the
  // DOM has already un-hidden it, since `toggleHiddenBySheet` reads `open`
  // directly and effects run after that render commits), so keyboard and
  // screen-reader users land on the conversation, then back on a real
  // focusable launcher, instead of wherever focus happened to be.
  // Skipped until `open` changes: on page load `open` is already false, and
  // focusing the launcher then would put the first Tab past the header and
  // the whole page (site audit 2026-09-30, F1). Only a real open/close
  // change moves focus.
  const lastOpen = useRef(open);
  useEffect(() => {
    if (lastOpen.current === open) return;
    const id = window.setTimeout(() => {
      lastOpen.current = open;
      if (open) {
        panelRef.current?.focus();
      } else {
        const opener = openerRef.current;
        openerRef.current = null;
        const target = opener && opener.isConnected && opener.getClientRects().length > 0 ? opener : button.current;
        target?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (!src) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // Sit above the sticky buy bar while it is showing; otherwise no lift.
      let edge = window.innerHeight;
      const bar = document.querySelector<HTMLElement>(BOTTOM_BAR)?.getBoundingClientRect();
      if (bar && bar.bottom > 0 && bar.top < window.innerHeight) edge = bar.top;
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
      // Phone sheet: same header clearance, no 600px cap - it fills down to
      // the bottom gutter instead of stopping at a card-sized height.
      setSheetTop(Math.round(Math.max(0, headerBottom) + HEADER_MARGIN_PX));
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

  // Marks the page while the launcher is mounted, so the stylesheet can keep
  // the text it lifts next to clear of its column (`.chatfpv-widget-on` in
  // app.css) instead of the button covering it.
  useEffect(() => {
    if (!src) return;
    const html = document.documentElement;
    html.classList.add('chatfpv-widget-on');
    return () => html.classList.remove('chatfpv-widget-on');
  }, [src]);

  // The mobile menu entry and the inline link under the buy box open the
  // same panel the launcher does.
  useEffect(() => {
    if (!src) return;
    const onOpen = (e: Event) => {
      const trigger = (e as CustomEvent<{trigger?: HTMLElement | null}>).detail?.trigger ?? null;
      openerRef.current = trigger;
      setUnread(false);
      setOpen(true);
      trackEvent('chatfpv_widget_open', {props: {surface: 'link'}});
    };
    window.addEventListener(CHATFPV_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CHATFPV_OPEN_EVENT, onOpen);
  }, [src]);

  // Without a launcher (phones) the unread handoff badge lives on the menu
  // entry and the inline link, through this class.
  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle('chatfpv-widget-unread', unread && !open);
    return () => html.classList.remove('chatfpv-widget-unread');
  }, [unread, open]);

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

  /** Shared close path for Escape, the panel header's own close button, and
   *  the launcher toggling shut. The pinned handoff dock/src and the
   *  returned focus are both handled by effects above, keyed off `open`/
   *  `mounted`, so they run after the DOM (and the phone sheet's launcher
   *  visibility) has actually updated. */
  function closePanel() {
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!src) return null;
  // Phone sheet only (never with `dock`: `handoffPlacement` already returns
  // null for the one-column phone layout, so a handoff there goes to
  // `unread` instead of `dock`). Fills from just under the header down to
  // the bottom gutter instead of the 600px-capped floating card.
  const sheet = isPhone && !dock;
  const sheetHidesLauncher = toggleHiddenBySheet(sheet, open);
  return (
    <div className={`chatfpv-widget${open ? ' is-open' : ''}`} style={{['--chatfpv-lift' as string]: `${lift}px`}}>
      {panelInDom ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="ChatFPV, beta AI assistant. Shopping and FPV help."
          tabIndex={-1}
          inert={!open}
          className={`chatfpv-widget-panel${expanded ? ' is-open' : ''}`}
          style={{
            ...(dock
              ? {position: 'fixed', bottom: 16, [dock.side]: 16, width: dock.width, height: dockHeight}
              : sheet
                ? {position: 'fixed', top: sheetTop, left: 16, right: 16, bottom: 16, width: 'auto', height: 'auto'}
                : {position: 'relative', width: 'min(400px, calc(100vw - 32px))', height: maxPanelHeight}),
            transformOrigin: panelTransformOrigin(dock?.side ?? null),
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
            background: '#0b0d10',
          }}
        >
          {/* Header: the same emblem as the closed launcher (so the roll-out
              reads as one continuous identity), title, the same "Beta" tag,
              a one-line subtitle, and the panel's own close button - the
              panel's identity used to be carried entirely by the data-use
              notice below, which read as an unfinished floating strip
              rather than a header (launch polish audit). */}
          <div className="chatfpv-widget-panel-header">
            <span className="chatfpv-widget-panel-icon">
              <OpenDroneAvatar size={26} />
            </span>
            <div className="chatfpv-widget-panel-heading-col">
              <div className="chatfpv-widget-panel-heading">
                <span className="chatfpv-widget-panel-title">ChatFPV</span>
                <span className="chatfpv-widget-beta-tag">Beta</span>
              </div>
              <p className="chatfpv-widget-panel-subtitle">Shopping and FPV help</p>
            </div>
            <button type="button" className="chatfpv-widget-panel-close" aria-label="Close ChatFPV" onClick={closePanel}>
              <PanelCloseIcon />
            </button>
          </div>
          {/* One line, always visible while the panel is open (before the
              first question, and through the loading and timeout states):
              the EU AI Act Art. 50 disclosure belongs at the moment of use,
              not floating over the page before the panel ever opens
              (storefront-launch iteration 2 audit: the closed-state notice
              covered the buy rail on phone and floated with no container on
              desktop dark). Closed, the widget shows only the button, same
              as main. Same panel background as the header above it (no
              separate strip colour) so it reads as one continuous panel. */}
          <details className="chatfpv-widget-notice" style={{flex: '0 0 auto', color: '#c7c7cc', borderBottom: '1px solid rgba(255,255,255,0.08)'}}>
            <summary style={{padding: '6px 14px', fontSize: 11, lineHeight: 1.4, cursor: 'pointer', listStyle: 'none', color: '#8b8b91'}}>
              {copyText('chrome.chatfpv_widget_notice_summary') ?? NOTICE_SUMMARY_FALLBACK}
            </summary>
            <p className="sp-hint" style={{margin: 0, padding: '0 14px 8px', fontSize: 12, lineHeight: 1.4}}>
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
        className={`chatfpv-widget-toggle${open ? ' is-open' : ' is-closed'}${sheetHidesLauncher ? ' is-sheet-hidden' : ''}`}
        aria-expanded={open}
        aria-hidden={sheetHidesLauncher || undefined}
        tabIndex={sheetHidesLauncher ? -1 : undefined}
        aria-label={open ? 'Close ChatFPV' : closedLabel(unread)}
        title={open ? 'Close ChatFPV' : closedLabel(unread)}
        onClick={() => {
          if (open) {
            closePanel();
            return;
          }
          setUnread(false);
          setOpen(true);
          trackEvent('chatfpv_widget_open', {props: {surface: 'widget'}});
        }}
      >
        {open ? (
          <CloseGlyph />
        ) : (
          <>
            <OpenDroneAvatar size={56} />
            {/* Separate element beside the emblem, never a recolour of it
                (OpenDrone/brand/AGENTS.md): a tiny dark pill so gold text
                reads on the gold background underneath. */}
            <span className="chatfpv-widget-launcher-beta" aria-hidden="true">
              Beta
            </span>
          </>
        )}
        {unread && !open ? (
          <span
            className="chatfpv-widget-unread"
            aria-hidden="true"
            style={{position: 'absolute', top: -7, left: -7, minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: '#e5484d', color: '#fff', fontSize: 12, fontWeight: 700, lineHeight: '20px', textAlign: 'center', boxShadow: '0 0 0 2px #0b0d10'}}
          >
            1
          </span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * The OpenDrone avatar (OpenDrone-Brand `avatar/opendrone-avatar.svg`, the OD
 * mark on the gold rounded square), unaltered, as both the closed widget
 * launcher (`size` 56) and the small icon in the open panel's own header
 * (`size` 26) - one identity rolling between the two states. Brand rule
 * (OpenDrone/brand/AGENTS.md): never recoloured or restyled; the "Beta" tag
 * beside it is a separate sibling element, not a change to the mark.
 */
function OpenDroneAvatar({size = 56}: {size?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <rect width="1024" height="1024" rx="230.4" fill="#ffb700" />
      <g transform="translate(205.8972,184.1815) scale(1.846)">
        <g transform="translate(0,433) scale(0.1,-0.1)" fillRule="evenodd">
          <path
            fill="#0d0d10"
            d="M1440 4319 C725 4245 212 3785 57 3079 C14 2882 5 2798 6 2550 C6 2289 20 2162 71 1960 C222 1370 636 955 1203 825 C1392 782 1713 766 1910 791 C2702 889 3214 1441 3300 2289 C3323 2526 3307 2858 3261 3070 C3139 3625 2795 4039 2300 4223 C2059 4312 1733 4349 1440 4319 Z M1345.5675 3665.9078 C1392.1719 3682.7225 1441.3278 3696.1029 1493 3706 C1593 3725 1791 3717 1895 3690 C2307 3584 2555 3195 2577 2625 C2601 1997 2343 1535 1900 1413 C1797 1385 1512 1387 1407 1418 C1386.1046 1424.0547 1365.6237 1430.8575 1345.5675 1438.3887 Z"
          />
        </g>
      </g>
    </svg>
  );
}

/** Small cross icon for the panel header's own close button (distinct from
 *  the 56px gold-square `CloseGlyph` the launcher shows once open). */
function PanelCloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 3 L13 13 M13 3 L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Open state: the same gold square with a close cross. */
function CloseGlyph() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true" focusable="false">
      <rect width="56" height="56" rx="12.6" fill="#ffb700" />
      <path d="M20 20 L36 36 M36 20 L20 36" stroke="#0d0d10" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
