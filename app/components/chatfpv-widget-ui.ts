/**
 * Pure, testable pieces of `ChatFpvWidget.tsx`'s chrome logic, split out
 * because that file has JSX and the test runner (`node --experimental-strip-types`)
 * cannot import a `.tsx` module directly - see `cart-add-lock.ts` for the
 * same pattern.
 */

/** Matches the existing `.buy-rail.is-mobile` / `@media (max-width: 959px)`
 *  "phones and tablets, single product column" breakpoint the widget's own
 *  stylesheet already uses elsewhere: the phone sheet and the compact
 *  launcher switch at the same width the rest of the page's layout does. */
export const PHONE_MAX_WIDTH_PX = 959;

/** How long the panel's roll-out/roll-back CSS transition runs
 *  (`.chatfpv-widget-panel` in app.css) - the panel stays mounted this long
 *  after closing so the collapse animation can finish before it leaves the
 *  DOM, instead of being cut off mid-transition. */
export const PANEL_ANIM_MS = 280;

/** Closed launcher's accessible name (aria-label and tooltip): always
 *  carries "beta" so a screen-reader visitor gets the same warning a
 *  sighted one reads on the small "Beta" tag overlapping the emblem, on
 *  every viewport width. */
export function closedLabel(unread: boolean): string {
  return unread ? 'Ask ChatFPV (AI, beta), 1 unread reply' : 'Ask ChatFPV (AI, beta)';
}

/**
 * Whether the floating round launcher should be visually hidden: only
 * while the phone sheet is both open and not a docked handoff panel (dock
 * never happens on the one-column phone layout - `handoffPlacement`
 * returns null there - so `sheet` and `dock` never disagree). The sheet
 * has its own header and close; a second launcher sitting on its corner is
 * unnecessary clutter there, unlike the desktop panel where it doubles as
 * a second close.
 */
export function toggleHiddenBySheet(sheet: boolean, open: boolean): boolean {
  return sheet && open;
}

/**
 * CSS `transform-origin` for the panel's roll-out animation: the corner
 * nearest the launcher, which always sits at the widget's fixed
 * bottom-right, however the panel itself is positioned. Only a
 * left-docked handoff panel (opened beside the product gallery, away from
 * the launcher) reads better rolling from its own near corner instead.
 */
export function panelTransformOrigin(dockSide: 'left' | 'right' | null): string {
  return dockSide === 'left' ? 'bottom left' : 'bottom right';
}

/** Below this width there is no floating launcher at all (audit round 3, A4):
 *  the panel is opened from the mobile menu entry and the inline link under
 *  the buy box instead. Mirrored by the `max-width: 767px` rule on
 *  `.chatfpv-widget-toggle` in app.css. */
export const NO_LAUNCHER_MAX_WIDTH_PX = 767;

/** Window event the menu entry and the inline link dispatch; the mounted
 *  widget opens its panel. `detail.trigger` is the element to focus again
 *  when the panel closes. */
export const CHATFPV_OPEN_EVENT = 'chatfpv:open';

export function requestChatFpvOpen(trigger?: HTMLElement | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHATFPV_OPEN_EVENT, {detail: {trigger: trigger ?? null}}));
}
