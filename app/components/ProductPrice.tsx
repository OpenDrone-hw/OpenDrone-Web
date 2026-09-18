import type {MoneyV2} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';

export function ProductPrice({
  price,
  compareAtPrice,
  discountLabel,
}: {
  price?: MoneyV2 | null;
  compareAtPrice?: MoneyV2 | null;
  /** The promotion's own wording (e.g. "Launch week"), shown as a small
   *  chip next to the price row. Only rendered alongside a compare price —
   *  a discount claim needs a struck-through price to point at. */
  discountLabel?: string | null;
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
          {discountLabel ? (
            <span className="product-price-discount">{discountLabel}</span>
          ) : null}
        </span>
      ) : price ? (
        formatPrice(price.amount, price.currencyCode)
      ) : (
        <span>&nbsp;</span>
      )}
    </span>
  );
}
