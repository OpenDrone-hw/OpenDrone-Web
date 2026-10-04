import type {EarlyPrice} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';
import {copyText} from '~/lib/copy';

const text = (id: string, fallback: string) => copyText(`preorder.${id}`) ?? fallback;

/*
 * A price is always one number. Where it is an early bird preorder price, a
 * page listing several products says so once (EarlyBirdNote) and the product
 * page names the retail price it rises to (EarlyBirdLine). Never a
 * struck-through "was" price: retail was never charged (Directive 98/6/EC
 * art. 6a).
 */

/** The one general line for a page or block that lists several prices. */
export function EarlyBirdNote({className = ''}: {className?: string}) {
  return <p className={`early-note ${className}`.trim()}>{text('early_note', 'Early bird preorder prices.')}</p>;
}

/** The product page line under an early bird price. */
export function EarlyBirdLine({early}: {early: EarlyPrice | null | undefined}) {
  if (!early) return null;
  return (
    <p className="early-line">
      <span className="early-line-lead">{text('early_price', 'Early bird price.')}</span>
      {early.retail
        ? ` ${text('early_retail', 'Retail {price}.').replace(
            '{price}',
            formatPrice(early.retail.amount, early.retail.currencyCode),
          )}`
        : null}
    </p>
  );
}
