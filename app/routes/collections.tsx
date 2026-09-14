import {redirect} from 'react-router';

/** The complete product listing replaces Shopify's collection index. */
export function loader() {
  throw redirect('/products', 301);
}
