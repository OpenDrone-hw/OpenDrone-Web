/**
 * The Shopify order and inventory webhooks are gone (contract section
 * 1.5). 410, not 404: the endpoint existed, was registered externally,
 * and must tell a caller it is permanently retired rather than look
 * like a routing mistake.
 */
export function loader() {
  throw new Response('Gone', {status: 410});
}

export function action() {
  throw new Response('Gone', {status: 410});
}
