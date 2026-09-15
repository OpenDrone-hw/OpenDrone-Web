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
 * The handler is React Router's own: Hydrogen's wrapper existed for the
 * Storefront client and `storefrontRedirect` (Shopify's URL redirect
 * table), neither of which exists any more. Oxygen still hosts and
 * builds the app (decision D3); it just has no Shopify API to call.
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

      // Product images: served from the edge cache, fetched from Odoo only
      // on a miss, before any session or catalog work (app/lib/odoo-image.ts).
      if (url.pathname.startsWith(ODOO_IMAGE_PREFIX)) {
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
      scheduleImageWarm(url.origin, env, context);

      // The Hydrogen package still augments React Router's AppLoadContext
      // with a Storefront client, a cart handler and a customer-account
      // client, none of which exist here; the cast is that type-level
      // ghost, not a runtime one.
      const response = await handleRequest(
        request,
        context as unknown as Parameters<typeof handleRequest>[1],
      );

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
