/**
 * The legacy /account/* behaviour, kept byte-for-byte while
 * ACCOUNTS_ENABLED is not "1": /account/support goes to "find my ticket",
 * everything else to the configured Shopify customer account URL (301), or
 * 404 when none is configured. No order, invoice or address path is invented.
 */
import {redirect} from 'react-router';
import {customerAccountUrl} from '~/lib/shop-links';

export function legacyAccountResponse(rest: string, env: Pick<Env, 'SHOPIFY_CUSTOMER_ACCOUNT_URL'>): never {
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
