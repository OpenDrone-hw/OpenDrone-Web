/**
 * The checkout GraphQL proxy is gone. 410 for the
 * same reason as the webhook receiver: a retired public endpoint.
 */
export function loader() {
  throw new Response('Gone', {status: 410});
}

export function action() {
  throw new Response('Gone', {status: 410});
}
