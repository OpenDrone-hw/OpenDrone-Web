import * as serverBuild from 'virtual:react-router/server-build';
import {createRequestHandler} from 'react-router';
import {createAppLoadContext, type AppLoadContext} from '~/lib/context';
import {
  catalogImageUrls,
  handleOdooImage,
  ODOO_IMAGE_PREFIX,
  warmOdooImages,
} from '~/lib/odoo-image';

/**
 * Export a fetch handler in module format.
 *
 * The handler is React Router's own. This module is the Cloudflare Worker
 * entry: the Cloudflare Vite plugin runs it in dev and builds it to
 * dist/server/index.js, which wrangler.production.toml deploys.
 */
const handleRequest = createRequestHandler(serverBuild, process.env.NODE_ENV);

const IMAGE_CACHE = 'opendrone-img';
const IMAGE_WARM_INTERVAL_MS = 30 * 60 * 1000;
let lastImageWarm = 0;

/**
 * Once per isolate per half hour, fill the image cache for every catalog
 * image this colo has not cached yet. A deploy starts fresh isolates, so the
 * first page request after it warms the cache while Odoo is still up.
 */
function scheduleImageWarm(origin: string, env: Env, context: AppLoadContext) {
  const now = Date.now();
  if (now - lastImageWarm < IMAGE_WARM_INTERVAL_MS) return;
  lastImageWarm = now;
  context.waitUntil(
    (async () => {
      const [catalog, cache] = await Promise.all([
        context.catalog.get(),
        caches.open(IMAGE_CACHE),
      ]);
      await warmOdooImages(origin, catalogImageUrls(catalog), {env, cache});
    })().catch((error) => {
      lastImageWarm = 0;
      console.error('[odoo-image] warm failed', error);
    }),
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    try {
      // www.opendrone.be is a Cloudflare custom domain too (both point at
      // this Worker, wrangler.toml), but Shopify today 301s www to the
      // apex rather than serving it (D13/D16: keep current behaviour, no
      // visual or structural change). Do the same redirect here so the
      // custom domain doesn't start silently serving www as a mirror.
      const url = new URL(request.url);
      if (url.hostname === 'www.opendrone.be') {
        url.hostname = 'opendrone.be';
        return Response.redirect(url.toString(), 301);
      }

      // The Shopify cutover retires the custom ticket API as one unit. New
      // support uses the public Discord/email page; old API URLs must never
      // instantiate a route loader or contact the retired Odoo backend.
      if (
        env.SHOPIFY_ADAPTER_PREVIEW === '1' &&
        url.pathname.startsWith('/api/support/')
      ) {
        return new Response('Support API retired. Use /support.', {
          status: 410,
          headers: {'Cache-Control': 'no-store'},
        });
      }

      // The retired image proxy remains reachable only during rollback mode.
      // Shopify preview uses Shopify CDN URLs directly and must not contact
      // Odoo even when an old image URL is requested.
      if (url.pathname.startsWith(ODOO_IMAGE_PREFIX)) {
        if (env.SHOPIFY_ADAPTER_PREVIEW === '1') {
          return new Response('Not Found', {status: 404});
        }
        return await handleOdooImage(request, {
          env,
          cache: await caches.open(IMAGE_CACHE).catch(() => undefined),
          waitUntil: executionContext.waitUntil.bind(executionContext),
        });
      }

      const context = await createAppLoadContext(
        request,
        env,
        executionContext,
      );
      if (!context.catalog.shopifyPreview) {
        scheduleImageWarm(url.origin, env, context);
      }

      const response = await handleRequest(request, context);

      if (context.session.isPending) {
        response.headers.set('Set-Cookie', await context.session.commit());
      }

      return response;
    } catch (error) {
      console.error(error);
      return new Response('An unexpected error occurred', {status: 500});
    }
  },
};
