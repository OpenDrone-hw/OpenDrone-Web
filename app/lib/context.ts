import {AppSession} from '~/lib/session';
import {createCatalogClient, type CatalogClient} from '~/lib/catalog-client';
import {assertRuntimeEnvironment} from '~/lib/runtime-env';

/**
 * The request context: env, the session cookie, the worker cache, the
 * waitUntil hook and the Odoo catalog client.
 *
 * This used to be Hydrogen's `createHydrogenContext`, which built a
 * Storefront API client, a cart handler and a customer-account client.
 * Odoo owns catalog, cart, checkout and accounts now (decision D3), so
 * the only backend client left is the read-only catalog feed.
 */
export type AppLoadContext = {
  env: Env;
  session: AppSession;
  cache: Cache;
  waitUntil: (p: Promise<unknown>) => void;
  catalog: CatalogClient;
};

declare module 'react-router' {
  interface AppLoadContext {
    env: Env;
    session: AppSession;
    cache: Cache;
    waitUntil: (p: Promise<unknown>) => void;
    catalog: CatalogClient;
  }
}

export async function createAppLoadContext(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
): Promise<AppLoadContext> {
  assertRuntimeEnvironment(env);

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
  };
}
