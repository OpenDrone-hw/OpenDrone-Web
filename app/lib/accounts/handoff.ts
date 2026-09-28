/**
 * ChatFPV handoff into the storefront widget (accounts contract, "Storefront
 * `#cfh`"). A ChatFPV product card links to `/products/<handle>?variant=<id>#cfh=<ticket>`;
 * the product page reads the ticket from the fragment, removes it from the
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
