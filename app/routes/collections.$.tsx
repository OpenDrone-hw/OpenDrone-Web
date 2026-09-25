import {redirect} from 'react-router';

/**
 * Collections were a Shopify concept. Every product lives on one listing
 * now, so /collections and /collections/all 301 to /products, and an old
 * category collection (/collections/receivers, /collections/frames, ...)
 * 301s to the listing filtered to that family, so an old link still lands
 * on the products it named. The values are the `family` keys in
 * `content/products/<handle>.json` that the listing's `type` filter reads.
 * Accessories and bundles are not mapped: none is on sale, and an empty
 * filtered listing helps nobody, so those land on the whole listing.
 */
const COLLECTION_FAMILY: Record<string, string> = {
  fc: 'Flight Controller',
  'flight-controller': 'Flight Controller',
  'flight-controllers': 'Flight Controller',
  esc: '4-in-1 ESC',
  escs: '4-in-1 ESC',
  '4-in-1-esc': '4-in-1 ESC',
  '4-in-1-escs': '4-in-1 ESC',
  rx: 'ELRS Receiver',
  receiver: 'ELRS Receiver',
  receivers: 'ELRS Receiver',
  'elrs-receiver': 'ELRS Receiver',
  'elrs-receivers': 'ELRS Receiver',
  frame: 'Carbon Frame',
  frames: 'Carbon Frame',
  'carbon-frame': 'Carbon Frame',
  'carbon-frames': 'Carbon Frame',
  motor: 'Motors',
  motors: 'Motors',
};

/** `/collections/<handle>[/...]` to its listing URL, keeping a search term. */
function collectionTarget(pathname: string, search = ''): string {
  const handle = decodeURIComponent(pathname.split('/').filter(Boolean)[1] ?? '')
    .trim()
    .toLowerCase();
  const term = new URLSearchParams(search).get('q')?.trim();
  const params = new URLSearchParams();
  const family = COLLECTION_FAMILY[handle];
  if (family) params.set('type', family);
  if (term) params.set('q', term);
  const query = params.toString();
  return query ? `/products?${query}` : '/products';
}

export function loader({request}: {request: Request}) {
  const url = new URL(request.url);
  throw redirect(collectionTarget(url.pathname, url.search), 301);
}
