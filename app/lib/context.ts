import {AppSession} from '~/lib/session';
import {createCatalogClient, type CatalogClient} from '~/lib/catalog-client';
import {
  createFundingOverlayClient,
  type FundingOverlayClient,
} from '~/lib/funding-overlay-client';

/**
 * The request context: env, the session cookie, the worker cache, the
 * waitUntil hook, the Odoo catalog client and the live funding overlay
 * client.
 *
 * This used to be Hydrogen's `createHydrogenContext`, which built a
 * Storefront API client, a cart handler and a customer-account client.
 * Odoo owns catalog, cart, checkout and accounts now (decision D3), so
 * the only backend clients left are the read-only catalog feed and the
 * lighter live funding feed layered on top of it.
 */
export type AppLoadContext = {
  env: Env;
  session: AppSession;
  cache: Cache;
  waitUntil: (p: Promise<unknown>) => void;
  catalog: CatalogClient;
  fundingOverlay: FundingOverlayClient;
};

declare module 'react-router' {
  interface AppLoadContext {
    env: Env;
    session: AppSession;
    cache: Cache;
    waitUntil: (p: Promise<unknown>) => void;
    catalog: CatalogClient;
    fundingOverlay: FundingOverlayClient;
  }
}

export async function createAppLoadContext(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
): Promise<AppLoadContext> {
  if (!env?.SESSION_SECRET) {
    throw new Error('SESSION_SECRET environment variable is not set');
  }

  const waitUntil = executionContext.waitUntil.bind(executionContext);
  const [cache, session] = await Promise.all([
    caches.open('opendrone'),
    AppSession.init(request, [env.SESSION_SECRET]),
  ]);

  return {
    env,
    session,
    cache,
    waitUntil,
    catalog: createCatalogClient({env, cache, waitUntil}),
    fundingOverlay: createFundingOverlayClient({env, cache, waitUntil}),
  };
}
