import {redirect} from 'react-router';

/**
 * /cart and the old /cart/<variant>:<qty> permalinks 301 to the product
 * listing: carts are created by the POST cart action and resolved through
 * /api/shopify/cart, so a permalink cart is never built here.
 */
export function loader() {
  throw redirect('/products', 301);
}
