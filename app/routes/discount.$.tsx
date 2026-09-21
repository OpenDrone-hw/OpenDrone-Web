import {redirect} from 'react-router';

/** Discount codes are entered in Shopify checkout. */
export function loader() {
  throw redirect('/products', 301);
}
