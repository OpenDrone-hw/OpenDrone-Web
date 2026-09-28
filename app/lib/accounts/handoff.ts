/**
 * ChatFPV handoff into the storefront widget (accounts contract, "Storefront
 * `#cfh`"). A ChatFPV product card links to
 * `/products/<handle>?Model=<option value>#cfh=<ticket>`, the option query
 * selecting the card's variant as the variant chips do; the product page reads the ticket from the fragment, removes it from the
 * address bar and opens the widget with the ticket in the iframe src
 * fragment, where ChatFPV's /embed redeems it. The ticket never travels in a
 * query parameter, so it stays out of server logs and the Referer header.
 *
 * Browser-safe: no server imports, the widget ships this to the client.
 */

/** "1": read `#cfh` on product pages and pass it to the widget iframe. */
export const handoffEnabled = (env: {HANDOFF_ENABLED?: string}) => env.HANDOFF_ENABLED?.trim() === '1';

/** 32 random bytes, base64url without padding: exactly 43 characters. */
const TICKET = /^[A-Za-z0-9_-]{43}$/;

/** The ticket in a `#cfh=<ticket>` fragment, or null for any other fragment. */
export function parseHandoffFragment(hash: string): string | null {
  const m = /^#?cfh=([^&]*)$/.exec(hash);
  return m && TICKET.test(m[1]) ? m[1] : null;
}

type HandoffWindow = {
  location: {hash: string; href: string};
  history: {state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void};
};

/**
 * Reads a `#cfh` ticket from the page URL and removes any `#cfh=` fragment,
 * valid or not, from the address bar (history.replaceState keeps path and
 * query, adds no history entry). Other fragments are left untouched.
 */
export function takeHandoffTicket(win: HandoffWindow): string | null {
  if (!/^#?cfh=/.test(win.location.hash)) return null;
  const ticket = parseHandoffFragment(win.location.hash);
  const url = new URL(win.location.href);
  url.hash = '';
  win.history.replaceState(win.history.state, '', url.pathname + url.search);
  return ticket;
}

/** The widget iframe src with the ticket in its fragment (never the query). */
export function withHandoffTicket(src: string, ticket: string): string {
  const u = new URL(src);
  u.hash = `cfh=${ticket}`;
  return u.toString();
}

/** Narrowest panel worth opening beside the product column. */
export const HANDOFF_PANEL_MIN_PX = 320;
export const HANDOFF_PANEL_MAX_PX = 400;
const HANDOFF_GUTTER_PX = 16;

export type HandoffPlacement = {side: 'right' | 'left'; width: number} | null;

/**
 * Where a handed-off conversation may open without covering the product
 * column (title, variant options, notify/buy area): beside it on the right,
 * else on the left over the gallery, each with a 16px gutter on both sides.
 * Null when neither side has HANDOFF_PANEL_MIN_PX, or the column spans most
 * of the viewport (the one-column phone layout): the widget then stays
 * closed with an unread badge instead of opening over the page.
 */
export function handoffPlacement(viewportWidth: number, column: {left: number; right: number} | null): HandoffPlacement {
  if (!column) return null;
  if (column.right - column.left > viewportWidth * 0.7) return null;
  const right = viewportWidth - column.right - 2 * HANDOFF_GUTTER_PX;
  if (right >= HANDOFF_PANEL_MIN_PX) return {side: 'right', width: Math.min(HANDOFF_PANEL_MAX_PX, Math.floor(right))};
  const left = column.left - 2 * HANDOFF_GUTTER_PX;
  if (left >= HANDOFF_PANEL_MIN_PX) return {side: 'left', width: Math.min(HANDOFF_PANEL_MAX_PX, Math.floor(left))};
  return null;
}
