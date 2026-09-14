import * as serverBuild from 'virtual:react-router/server-build';
import {createRequestHandler} from 'react-router';
import {createAppLoadContext} from '~/lib/context';
import {RuntimeConfigurationError} from '~/lib/runtime-env';

/**
 * Export a fetch handler in module format.
 *
 * The handler is React Router's own: Hydrogen's wrapper existed for the
 * Storefront client and `storefrontRedirect` (Shopify's URL redirect
 * table), neither of which exists any more. Cloudflare runs the generated
 * Worker directly; no Shopify API is called.
 */
const handleRequest = createRequestHandler(serverBuild, process.env.NODE_ENV);

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    try {
      // www.opendrone.be is a Cloudflare custom domain too (both point at
      // this Worker in production). Keep one public origin for SEO and
      // session behavior by redirecting www to the apex.
      const url = new URL(request.url);
      if (url.hostname === 'www.opendrone.be') {
        url.hostname = 'opendrone.be';
        return Response.redirect(url.toString(), 301);
      }

      const context = await createAppLoadContext(
        request,
        env,
        executionContext,
      );

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
      return new Response('An unexpected error occurred', {
        status: error instanceof RuntimeConfigurationError ? 503 : 500,
        headers: {'Cache-Control': 'no-store'},
      });
    }
  },
};
