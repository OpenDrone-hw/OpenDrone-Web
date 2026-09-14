import * as serverBuild from 'virtual:react-router/server-build';
import {createRequestHandler} from 'react-router';
import {createAppLoadContext} from '~/lib/context';

/**
 * Export a fetch handler in module format.
 *
 * The handler is React Router's own: Hydrogen's wrapper existed for the
 * Storefront client and `storefrontRedirect` (Shopify's URL redirect
 * table), neither of which exists any more. Oxygen still hosts and
 * builds the app (decision D3); it just has no Shopify API to call.
 */
const handleRequest = createRequestHandler(serverBuild, process.env.NODE_ENV);

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    try {
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
