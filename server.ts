import * as serverBuild from 'virtual:react-router/server-build';
import {createRequestHandler} from 'react-router';
import {createAppLoadContext} from '~/lib/context';

/**
 * Export a fetch handler in module format.
 *
 * The handler is React Router's own. This module is the Cloudflare Worker
 * entry: the Cloudflare Vite plugin runs it in dev and builds it to
 * dist/server/index.js, which wrangler.production.toml deploys.
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
      // this Worker); redirect it to the apex so it never serves a mirror.
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
  },
};
