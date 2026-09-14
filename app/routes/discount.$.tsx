import {redirect} from 'react-router';

/** Discount codes are entered in the Odoo cart (contract section 1.3). */
export function loader() {
  throw redirect('/products', 301);
}
