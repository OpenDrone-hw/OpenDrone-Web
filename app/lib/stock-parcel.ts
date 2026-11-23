import {stockPromise} from './preorder-campaign.ts';

/**
 * True when the cart ships from stock (every promised line is in stock) and
 * the candidate does not: adding it holds the whole one-parcel order until
 * the candidate's batch, in-stock boards included (settleOffers).
 */
export function delaysStockParcel(
  cartPromises: Array<string | null | undefined>,
  candidate: string | null | undefined,
): boolean {
  const promised = cartPromises.filter((p): p is string => Boolean(p?.trim()));
  return promised.length > 0 && promised.every(stockPromise) && Boolean(candidate?.trim()) && !stockPromise(candidate);
}
