/**
 * The legacy /account/* behaviour while ACCOUNTS_ENABLED is not "1":
 * /account/support goes to "find my ticket", everything else to the
 * Shopify customer account URL (301) that customerAccountUrl resolves -
 * SHOPIFY_CUSTOMER_ACCOUNT_URL when set, else derived from the numeric
 * SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID - or 404 when neither is configured.
 * Production runs with ACCOUNTS_ENABLED "1", so this path is not live
 * there; it now also redirects (instead of 404) wherever a rollback to
 * "0" leaves SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID set without an explicit URL.
 */
import {redirect} from 'react-router';
import {customerAccountUrl} from '~/lib/shop-links';

export function legacyAccountResponse(
  rest: string,
  env: Pick<Env, 'SHOPIFY_CUSTOMER_ACCOUNT_URL' | 'SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID'>,
): never {
  if (/^support(\/|$)/.test(rest.replace(/^\/+/, ''))) {
    throw redirect('/support/find', 301);
  }
  const destination = customerAccountUrl(env);
  if (!destination) {
    throw new Response('Customer accounts are not configured.', {
      status: 404,
      headers: {'Cache-Control': 'no-store'},
    });
  }
  throw redirect(destination, 301);
}
