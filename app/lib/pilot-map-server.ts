/**
 * Route glue for the pilot map: who is looking, what they may see, and the
 * local-development switches. The rules are in pilot-map.ts and the storage
 * in pilot-map-data.ts; this file only wires them to a request.
 *
 * Local dev (`import.meta.env.DEV`, folded to `false` and dropped by a
 * production build, same rule as app/lib/support/dev-overrides.ts): the test
 * IdP's first customer counts as an owner and Shopify is never asked, and
 * "Link Discord" goes to the fake screen (pilot-map-dev.ts) unless real
 * Discord credentials are set.
 */
import type {EarlyBirdOrder} from './early-bird';
import {readSession, type AccountSession} from './accounts/sessions';
import {
  customerIsOwner,
  discordConfigured,
  ownerCookie,
  ownerCookieValid,
  pilotMapEnabled,
  pilotView,
  readLink,
  readOwnPin,
  type Link,
  type OwnPin,
  type PilotEnv,
} from './pilot-map-data';
import type {PilotView} from './pilot-map';

export type Viewer = {
  session: AccountSession | null;
  owner: boolean;
  /** Set-Cookie values the response must carry. */
  cookies: string[];
};

/** The test IdP customer whose mock account has paid orders (account._index.tsx devMockAccount). */
const DEV_OWNER_GID = 'gid://shopify/Customer/test-1';

const devOrders = async (_env: unknown, gid: string): Promise<EarlyBirdOrder[] | null> =>
  gid === DEV_OWNER_GID ? [{cancelledAt: null, displayFinancialStatus: 'PAID'} as EarlyBirdOrder] : [];

/** The session and whether it is a qualifying owner. Shopify is asked at most once an hour per browser. */
export async function readViewer(env: PilotEnv, request: Request): Promise<Viewer> {
  const session = await readSession(env.SUPPORT_DB, request);
  const cookies: string[] = [];
  if (!session) return {session: null, owner: false, cookies};
  if (session.refreshCookie) cookies.push(session.refreshCookie);
  let owner = await ownerCookieValid(env, request, session.shopifyGid);
  if (!owner) {
    owner = await customerIsOwner(env, session.shopifyGid, import.meta.env.DEV ? devOrders : undefined);
    const cookie = owner ? await ownerCookie(env, session.shopifyGid) : null;
    if (cookie) cookies.push(cookie);
  }
  return {session, owner, cookies};
}

/** Real Discord is configured, or this is the dev server (fake Discord). */
export const discordAvailable = (env: PilotEnv): boolean => discordConfigured(env) || Boolean(import.meta.env.DEV);

/** The dev fake stands in for Discord on the dev server when no credentials are set. */
export const devDiscordActive = (env: PilotEnv): boolean => Boolean(import.meta.env.DEV) && !discordConfigured(env);

export type PilotPanel =
  | {enabled: false}
  | {
      enabled: true;
      signedIn: boolean;
      owner: boolean;
      view: PilotView;
      own: OwnPin | null;
      linkedName: string | null;
      canLink: boolean;
    };

/**
 * Everything the owners page needs about the pilot map for this viewer.
 * `view.cells` is filled only for a signed-in qualifying owner: this is the
 * server-side enforcement, the browser's claims are never consulted.
 */
export async function pilotPanel(env: PilotEnv, request: Request): Promise<{panel: PilotPanel; cookies: string[]}> {
  if (!pilotMapEnabled(env)) return {panel: {enabled: false}, cookies: []};
  const db = env.SUPPORT_DB!;
  const viewer = await readViewer(env, request);
  const gid = viewer.session?.shopifyGid ?? null;
  const [view, own, link] = await Promise.all([
    pilotView(db, viewer.owner),
    viewer.owner && gid ? readOwnPin(db, gid) : Promise.resolve(null),
    viewer.owner && gid ? readLink(env, request, gid) : Promise.resolve<Link | null>(null),
  ]);
  return {
    panel: {
      enabled: true,
      signedIn: Boolean(viewer.session),
      owner: viewer.owner,
      view,
      own,
      linkedName: link?.name ?? null,
      canLink: discordAvailable(env),
    },
    cookies: viewer.cookies,
  };
}
