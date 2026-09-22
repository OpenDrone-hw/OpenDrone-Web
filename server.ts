import * as serverBuild from 'virtual:react-router/server-build';
import {createRequestHandler} from 'react-router';
import {createAppLoadContext} from '~/lib/context';
import {parseCampaignConfig} from '~/lib/preorder-campaign';
import {reconcilePreorders} from '~/lib/preorder-ops';
import {priceTierWritesEnabled} from '~/lib/shopify-price-tier';
import preordersJson from './content/preorders.json';

/**
 * Staging gate. The preview Worker is a public workers.dev URL, so it asks
 * for HTTP basic auth before any page or API response. Static files in
 * dist/client are served by Cloudflare without running the Worker, so they
 * are not gated. The production Worker leaves STAGING_PASSWORD unset and
 * never asks.
 */
function stagingGate(request: Request, env: Env): Response | null {
  const password = env.STAGING_PASSWORD?.trim();
  if (!password) return null;
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const [user, given] = atob(header.slice(6)).split(':');
      if (user === 'opendrone' && given === password) return null;
    } catch {
      // Malformed header: fall through and ask again.
    }
  }
  return new Response('Staging', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="OpenDrone staging", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/**
 * Staging must never be indexed, even if the basic-auth gate is later
 * loosened: every Worker response with STAGING_PASSWORD set carries
 * `X-Robots-Tag: noindex, nofollow`. Production leaves it unset.
 */
function markStaging(response: Response, env: Env): Response {
  if (!env.STAGING_PASSWORD?.trim()) return response;
  try {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  } catch {
    // Immutable headers (a fetched or redirect response): copy it.
    const copy = new Response(response.body, response);
    copy.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return copy;
  }
}

/**
 * Export a fetch handler in module format.
 *
 * The handler is React Router's own. This module is the Cloudflare Worker
 * entry: the Cloudflare Vite plugin runs it in dev and builds it to
 * dist/server/index.js, which wrangler.production.toml deploys.
 */
const handleRequest = createRequestHandler(serverBuild, process.env.NODE_ENV);

async function handleFetch(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
): Promise<Response> {
  try {
    // www.opendrone.be is a Cloudflare custom domain too (both point at
    // this Worker); redirect it to the apex so it never serves a mirror.
    const gate = stagingGate(request, env);
    if (gate) return gate;

    const url = new URL(request.url);
    if (url.hostname === 'www.opendrone.be') {
      url.hostname = 'opendrone.be';
      return Response.redirect(url.toString(), 301);
    }

    // The custom ticket API is retired as one unit. Support is the public
    // Discord/email page; old API URLs answer 410 so clients stop retrying.
    if (url.pathname.startsWith('/api/support/')) {
      return new Response('Support API retired. Use /support.', {
        status: 410,
        headers: {'Cache-Control': 'no-store'},
      });
    }

    const context = await createAppLoadContext(
      request,
      env,
      executionContext,
    );
    const response = await handleRequest(request, context);

    if (context.session.isPending) {
      response.headers.set('Set-Cookie', await context.session.commit());
    }

    return response;
  } catch (error) {
    console.error(error);
    return new Response('An unexpected error occurred', {status: 500});
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    return markStaging(await handleFetch(request, env, executionContext), env);
  },

  /**
   * Reconcile the preorder price steps and holds (wrangler `[triggers]
   * crons`, every five minutes). The orders/paid webhook does this the
   * moment an order is paid; this catches a delivery Shopify never made and
   * any paid preorder order not yet held and tagged. Off unless
   * SHOPIFY_PRICE_TIER_WRITE_ENABLED is '1'.
   */
  async scheduled(_event: unknown, env: Env, executionContext: ExecutionContext): Promise<void> {
    if (!priceTierWritesEnabled(env)) return;
    executionContext.waitUntil(
      (async () => {
        try {
          const config = parseCampaignConfig(preordersJson);
          const result = await reconcilePreorders(env, config);
          if (result.changed.length) {
            console.log('preorder price steps written', JSON.stringify(result.changed));
          }
          if (result.held.length) {
            console.log('preorder orders held', JSON.stringify(result.held));
          }
        } catch (error) {
          console.error('preorder price step reconcile failed', error);
        }
      })(),
    );
  },
};
