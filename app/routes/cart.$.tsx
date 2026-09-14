import {redirect} from 'react-router';

/**
 * The cart lives on the shop (contract section 1.3). /cart and the old
 * /cart/<variant>:<qty> permalinks 301 to the product listing: the
 * permalink ids were Shopify variant gids and mean nothing to Odoo, so
 * sending a visitor to a cart we cannot build would be a dead end.
 */
export function loader() {
  throw redirect('/products', 301);
}
