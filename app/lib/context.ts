import {AppSession} from '~/lib/session';
import {createCatalogClient, type CatalogClient} from '~/lib/catalog-client';

/**
 * The request context: env, the session cookie, the worker cache, the
 * waitUntil hook and the Shopify catalog client.
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
    catalog: createCatalogClient({env}),
  };
}
