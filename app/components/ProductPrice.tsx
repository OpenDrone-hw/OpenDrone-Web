import type {MoneyV2} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';

/** The price as one absolute euro amount. No struck-through "was" price:
 *  a preorder's standard price was never charged (Directive 98/6/EC art. 6a). */
export function ProductPrice({price}: {price?: MoneyV2 | null}) {
  return (
    <span className="product-price">
      {price ? formatPrice(price.amount, price.currencyCode) : <span>&nbsp;</span>}
    </span>
  );
}
