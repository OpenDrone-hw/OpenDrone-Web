import {redirect} from 'react-router';

/**
 * Search was Shopify's predictive search over products, pages and
 * articles. The product listing carries a client-side filter over the
 * catalog instead, so /search 301s there with the term preserved.
 */
export function loader({request}: {request: Request}) {
  const term = new URL(request.url).searchParams.get('q');
  throw redirect(term ? `/products?q=${encodeURIComponent(term)}` : '/products', 301);
}
