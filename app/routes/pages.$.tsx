/**
 * Shopify CMS pages are gone and nothing on this site linked to one, so
 * /pages/* is a plain 404 rather than a redirect (contract section 7).
 */
export function loader() {
  throw new Response(null, {status: 404});
}
