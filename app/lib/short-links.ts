/**
 * Short and mistyped paths people say in videos or type by hand. Each one
 * 301s to its page, keeping the query string so `?ref=` attribution survives.
 */
export const SHORT_LINKS: Record<string, string> = {
  '/opensource': '/open-source',
  '/openfc': '/products/openfc-lite',
  '/fc': '/products/openfc-lite',
  '/openesc': '/products/openesc',
  '/esc': '/products/openesc',
  '/openrx': '/products/openrx',
  '/rx': '/products/openrx',
  '/openframe': '/products/openframe',
  '/frame': '/products/openframe',
  '/openmotor': '/products/openmotor',
  '/motors': '/products/openmotor',
  '/build': '/#build-guide',
  '/kit': '/#build-guide',
  '/github': 'https://github.com/OpenDrone-hw',
  '/discord': 'https://discord.gg/v3sWmTcx3R',
};

export function shortLinkTarget(pathname: string, search: string): string | null {
  const key = pathname.toLowerCase().replace(/\/+$/, '');
  const target = SHORT_LINKS[key];
  if (!target) return null;
  if (!search || target.startsWith('http')) return target;
  const [path, hash] = target.split('#');
  return `${path}${search}${hash ? `#${hash}` : ''}`;
}
