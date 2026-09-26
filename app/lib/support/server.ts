/**
 * Glue between routes and the ticket rules: builds the dependencies from the
 * Worker env, resolves which tickets a request may open, and checks that a
 * POST came from this site.
 */
import {createDraftStore} from './ai-drafts.ts';
import {createChatFpvClient, draftsEnabled, type ChatFpvEnv} from './chatfpv.ts';
import {createDiscordClient, discordConfigured} from './discord.ts';
import {createStore, type Ticket} from './store.ts';
import type {Deps, SupportEnv} from './tickets.ts';
import {readTicketCookie, type CookieTicket} from './tokens.ts';

export type SupportWorkerEnv = SupportEnv & ChatFpvEnv & {SUPPORT_DB?: D1Database};

/** Tickets can be opened: storage, Discord and a signing secret are there. */
export function supportReady(env: SupportWorkerEnv): boolean {
  return Boolean(env.SUPPORT_DB && discordConfigured(env) && (env.SUPPORT_SESSION_SECRET || env.SESSION_SECRET));
}

export function supportDeps(env: SupportWorkerEnv, origin: string, defer?: (p: Promise<unknown>) => void): Deps {
  if (!env.SUPPORT_DB) throw new Error('SUPPORT_DB binding missing');
  return {
    env,
    store: createStore(env.SUPPORT_DB),
    discord: createDiscordClient(env),
    origin,
    defer,
    // ChatFPV ticket drafts: absent unless CHATFPV_DRAFTS_ENABLED is "1".
    chatfpv: draftsEnabled(env) ? {client: createChatFpvClient(env), drafts: createDraftStore(env.SUPPORT_DB)} : undefined,
  };
}

/** The public origin: the request's, which on production is https://opendrone.be. */
export function originOf(request: Request): string {
  return new URL(request.url).origin;
}

/** Cookies are Secure except on plain-http localhost during development. */
export function secureCookies(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

/** A state-changing request must come from a page of this site. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}

/** The ticket, if this browser's cookie holds its reference at the current link version. */
export async function authorizedTicket(
  deps: Deps,
  request: Request,
  ref: string,
): Promise<{ticket: Ticket | null; cookie: CookieTicket[]}> {
  const cookie = await readTicketCookie(deps.env, request);
  const entry = cookie.find((c) => c.r === ref);
  if (!entry) return {ticket: null, cookie};
  const ticket = await deps.store.getTicket(ref);
  if (!ticket || ticket.linkVersion !== entry.k) return {ticket: null, cookie};
  return {ticket, cookie};
}

type HeaderArgs = {loaderHeaders?: Headers; actionHeaders?: Headers; errorHeaders?: Headers};

/**
 * `headers` for the support routes. React Router drops headers a loader or
 * action returns unless the route exports this: without it the private,
 * no-store and noindex headers never reach the browser, and an action's
 * Set-Cookie is lost on a no-JavaScript POST. Every support page is
 * private and never cached.
 */
export function supportHeaders({loaderHeaders, actionHeaders, errorHeaders}: HeaderArgs): Headers {
  const out = new Headers();
  for (const h of [loaderHeaders, actionHeaders, errorHeaders]) {
    if (!h) continue;
    h.forEach((value, key) => {
      if (key !== 'set-cookie') out.set(key, value);
    });
    for (const cookie of h.getSetCookie()) out.append('Set-Cookie', cookie);
  }
  out.set('Cache-Control', 'private, no-store');
  out.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}
