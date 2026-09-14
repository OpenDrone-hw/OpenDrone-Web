import {redirect} from 'react-router';

/**
 * Collections were a Shopify concept. Every product lives on one listing
 * now, so /collections, /collections/all and /collections/<handle> all
 * 301 to /products (contract section 7).
 */
export function loader() {
  throw redirect('/products', 301);
}
