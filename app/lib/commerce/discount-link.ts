/**
 * Shopify's shareable discount links, `/discount/<code>` with an optional `?redirect=<path>`, as the app checkout reads
 * them: the code goes into the cart options (the app's quote prices it and says why when it does not apply) and the buyer
 * lands on the page the link names. Only a path of this site is followed, never another host.
 *
 * Plain TypeScript with relative imports only: the node:test suites load it without the bundler.
 */
import {cleanOptions} from './app-cart-options.ts';

export type DiscountLink = {code: string; to: string};

export function discountLink(url: URL): DiscountLink {
  const segment = url.pathname.split('/').filter(Boolean)[1] ?? '';
  let raw = '';
  try {
    raw = decodeURIComponent(segment);
  } catch {
    raw = '';
  }
  const target = url.searchParams.get('redirect') ?? '';
  const sameSite = target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\');
  return {code: cleanOptions({code: raw}).code, to: sameSite ? target : '/products'};
}
