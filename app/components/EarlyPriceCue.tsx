import {useRouteLoaderData} from 'react-router';
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

/**
 * The one general line for a page or block that lists several prices: only
 * while the shop shows prices and at least one listed price is an early bird
 * price.
 */
export function EarlyBirdNote({show, className = ''}: {show: boolean; className?: string}) {
  // Prices show while the shop is not coming soon; fail closed without root data.
  const root = useRouteLoaderData('root') as {comingSoon?: boolean} | undefined;
  if (!show || root?.comingSoon !== false) return null;
  return <p className={`early-note ${className}`.trim()}>{text('early_note', 'Early bird preorder prices.')}</p>;
}

/** Whether any variant of these products sells at an early bird price. */
export function anyEarlyPrice(
  products: Array<{variants: {nodes: Array<{earlyPrice?: EarlyPrice | null}>}} | null | undefined>,
): boolean {
  return products.some((p) => p?.variants.nodes.some((v) => v.earlyPrice != null) ?? false);
}

/** Whether any of these cart lines is a SKU the catalog sells at an early
 *  bird price (the root loader's catalog cards). */
export function useAnyEarlySku(skus: Array<string | null | undefined>): boolean {
  const root = useRouteLoaderData('root') as
    | {familyProducts?: Array<{variants: {nodes: Array<{sku?: string | null; earlyPrice?: EarlyPrice | null}>}}>}
    | undefined;
  const early = new Set(
    (root?.familyProducts ?? []).flatMap((p) =>
      p.variants.nodes.filter((v) => v.earlyPrice != null && v.sku).map((v) => v.sku as string),
    ),
  );
  return skus.some((sku) => sku != null && early.has(sku));
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
