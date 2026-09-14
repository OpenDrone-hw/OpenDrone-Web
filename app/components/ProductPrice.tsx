import type {MoneyV2} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';

export function ProductPrice({
  price,
  compareAtPrice,
}: {
  price?: MoneyV2 | null;
  compareAtPrice?: MoneyV2 | null;
}) {
  return (
    <span className="product-price">
      {compareAtPrice ? (
        <span className="product-price-row">
          {price ? (
            <span className="product-price-sale">
              {formatPrice(price.amount, price.currencyCode)}
            </span>
          ) : null}
          <s className="product-price-compare">
            {formatPrice(compareAtPrice.amount, compareAtPrice.currencyCode)}
          </s>
        </span>
      ) : price ? (
        formatPrice(price.amount, price.currencyCode)
      ) : (
        <span>&nbsp;</span>
      )}
    </span>
  );
}
