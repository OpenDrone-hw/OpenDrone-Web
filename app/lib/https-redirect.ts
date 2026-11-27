/** The production hostnames. Plain HTTP to either one moves to the HTTPS apex. */
const PRODUCTION_HOSTS = new Set(['opendrone.be', 'www.opendrone.be']);

/**
 * A plain-HTTP request on the production host gets a permanent redirect to
 * HTTPS, so a first visit (before the browser holds the HSTS entry) never
 * stays on cleartext. GET and HEAD get 301; other methods 308 so the method
 * and body survive. Localhost, workers.dev and every other host pass
 * through (null).
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' || !PRODUCTION_HOSTS.has(url.hostname)) return null;
  url.protocol = 'https:';
  url.hostname = 'opendrone.be';
  url.port = '';
  const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
  return new Response(null, {status, headers: {Location: url.toString()}});
}
