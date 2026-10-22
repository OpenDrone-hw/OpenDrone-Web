/**
 * Early Bird claim for an app order (app mode): the claim link in the app's payment mail is
 * `/early-bird?order=<number>&key=<status key>`. The app proves the order from the key and says whether it qualifies
 * (`storefront.early_bird`: paid, canceled, a qualifying line by its own config); this Worker adds the close date it already
 * owns and hands the claim to the Discord bot like a Shopify order.
 *
 * The facts are mapped onto the `EarlyBirdOrder` shape so `ineligibility` stays the one place for the rule. The order id the
 * bot records is `app:order/<number>`, the app's own alias of the order; it cannot collide with a Shopify gid.
 */
import {ineligibility, type EarlyBirdOrder} from '../early-bird.ts';
import {appOp, type AppEnv} from './app-api.ts';
import type {AccountOrder} from './app-account.ts';

export type EarlyBirdFacts = {number: string; created: string; enabled: boolean; paid: boolean; canceled: boolean; qualifying: boolean};

const NUMBER = /^[A-Za-z0-9-]{1,20}$/;
const KEY = /^[0-9a-f]{16,64}$/;

/** The link's order number, or null when it is not an app order number. */
export function appOrderNumber(raw: string | null): string | null {
  return raw && NUMBER.test(raw) ? raw : null;
}

export function appKey(raw: string | null): string | null {
  return raw && KEY.test(raw) ? raw : null;
}

export function toEarlyBirdOrder(facts: EarlyBirdFacts): EarlyBirdOrder | null {
  if (!facts.enabled) return null;
  return {
    id: `app:order/${facts.number}`,
    name: `#${facts.number}`,
    createdAt: facts.created,
    cancelledAt: facts.canceled ? facts.created : null,
    displayFinancialStatus: facts.paid ? 'PAID' : 'PENDING',
    // `ineligibility` asks for the preorder tag; the app already decided from its own rule.
    tags: facts.qualifying ? ['preorder'] : [],
    statusPageUrl: null,
    customer: null,
    lineItems: {nodes: []},
  };
}

/** The order the key proves, or null when the app does not know it (or the key is not valid). Throws AppUnavailable. */
export async function readAppOrder(env: AppEnv, number: string, key: string, fetcher: typeof fetch = fetch): Promise<EarlyBirdOrder | null> {
  const out = await appOp<EarlyBirdFacts>(env, 'storefront.early_bird', {number, key}, fetcher);
  return out.ok && out.data ? toEarlyBirdOrder(out.data) : null;
}

export type AccountOrderRow = {id: string; name: string; createdAt: string};

/**
 * The signed-in customer's orders that can still be claimed, from `storefront.account` (app mode). That answer carries
 * payment state, cancellation and date but not the sale mode per line, so "has a preorder item" cannot be judged here:
 * it is assumed, and the claim link of the order's payment mail (`storefront.early_bird`, proven by the mail key) makes
 * the final call. The paid, cancelled and close date rules are the shared `ineligibility`.
 */
export function accountClaimRows(orders: AccountOrder[], endsOn: string): AccountOrderRow[] {
  const rows: AccountOrderRow[] = [];
  for (const o of orders) {
    const order = toEarlyBirdOrder({number: o.number, created: o.created, enabled: true, paid: o.state.payment === 'paid' || o.state.payment === 'partially_refunded', canceled: o.canceled, qualifying: true});
    if (order && ineligibility(order, endsOn) === null) rows.push({id: order.id, name: order.name, createdAt: order.createdAt});
  }
  return rows;
}
