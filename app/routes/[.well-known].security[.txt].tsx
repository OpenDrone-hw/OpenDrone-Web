import type {Route} from './+types/[.well-known].security[.txt]';

/**
 * RFC 9116 security.txt resource route. Machine-readable contact record
 * for vulnerability disclosure - paired with /security human-readable page.
 */
export async function loader(_args: Route.LoaderArgs) {
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  const body = [
    'Contact: mailto:security@opendrone.be',
    'Preferred-Languages: en, nl, fr',
    'Canonical: https://opendrone.be/.well-known/security.txt',
    'Policy: https://opendrone.be/security',
    `Expires: ${expires.toISOString()}`,
    '',
  ].join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
