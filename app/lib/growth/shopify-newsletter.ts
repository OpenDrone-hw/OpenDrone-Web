import {soldThroughShops} from '../shipping-rates.ts';

type NewsletterEnv = Pick<
  Env,
  | 'SHOPIFY_NEWSLETTER_WRITE_ENABLED'
  | 'SHOPIFY_STORE_DOMAIN'
  | 'SHOPIFY_ADMIN_API_TOKEN'
  | 'SHOPIFY_ADMIN_API_VERSION'
>;

type MarketingState = 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'NOT_SUBSCRIBED' | 'PENDING' | 'REDACTED';
type Customer = {
  id: string;
  email: string | null;
  emailMarketingConsent: {marketingState: MarketingState} | null;
};
type GraphqlResponse<T> = {data?: T; errors?: unknown[]};

const CUSTOMER_QUERY = `query NewsletterCustomerByEmail($query: String!) {
  customers(first: 10, query: $query) {
    nodes { id email emailMarketingConsent { marketingState } }
  }
}`;
const CREATE_CUSTOMER = `mutation NewsletterCustomerCreate($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { id email emailMarketingConsent { marketingState } }
    userErrors { field message }
  }
}`;
const UPDATE_CONSENT = `mutation NewsletterConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
  customerEmailMarketingConsentUpdate(input: $input) {
    customer { id email emailMarketingConsent { marketingState } }
    userErrors { field message }
  }
}`;
const ADD_TAGS = `mutation NewsletterTagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

function adminDomain(raw: string | undefined): string | null {
  const domain = raw?.trim().toLowerCase();
  return domain && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
    ? domain
    : null;
}

async function admin<T>(env: NewsletterEnv, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const domain = adminDomain(env.SHOPIFY_STORE_DOMAIN);
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token) return null;
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || '2026-07';
  const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query, variables}),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const result = (await response.json()) as GraphqlResponse<T>;
  return result.errors?.length ? null : result.data ?? null;
}

function exactCustomer(nodes: Customer[], email: string): Customer | null {
  const normalized = email.trim().toLowerCase();
  return nodes.find((customer) => customer.email?.trim().toLowerCase() === normalized) ?? null;
}

function successfulConsent(customer: Customer | null | undefined, expected: MarketingState): boolean {
  return Boolean(customer?.id && customer.emailMarketingConsent?.marketingState === expected);
}

/**
 * Shopify is the consent owner. An existing unsubscribe is never cleared by
 * signup.
 *
 * `subscribed` means the address actually joined on this call; an address that
 * was already SUBSCRIBED returns `already-subscribed`. Both are successes, and
 * the caller tells them apart so a repeat submit does not send a second
 * welcome mail.
 *
 * `country` is the visitor's country. One sold only through shops adds a
 * `country-<CODE>` tag (`country-US`), so those subscribers can be told when
 * direct sales open there; EU, blocked and unknown countries add none.
 */
export async function subscribeWithShopify(
  env: NewsletterEnv,
  email: string,
  productHandle?: string,
  country?: string | null,
): Promise<
  'subscribed' | 'already-subscribed' | 'suppressed' | 'disabled' | 'failed'
> {
  if (env.SHOPIFY_NEWSLETTER_WRITE_ENABLED !== '1') return 'disabled';
  try {
    const found = await admin<{customers: {nodes: Customer[]}}>(env, CUSTOMER_QUERY, {
      query: `email:"${email.replace(/"/g, '')}"`,
    });
    if (!found) return 'failed';
    const existing = exactCustomer(found.customers.nodes, email);
    if (existing?.emailMarketingConsent?.marketingState === 'UNSUBSCRIBED') return 'suppressed';
    const alreadySubscribed =
      existing?.emailMarketingConsent?.marketingState === 'SUBSCRIBED';
    const consent = {
      marketingState: 'SUBSCRIBED',
      marketingOptInLevel: 'SINGLE_OPT_IN',
      consentUpdatedAt: new Date().toISOString(),
    };
    const tags = [
      'newsletter',
      ...(productHandle ? [`notify-${productHandle}`] : []),
      ...(country && soldThroughShops(country) ? [`country-${country.trim().toUpperCase()}`] : []),
    ];
    if (existing) {
      const written = await admin<{
        customerEmailMarketingConsentUpdate: {customer: Customer | null; userErrors: unknown[]};
      }>(env, UPDATE_CONSENT, {input: {customerId: existing.id, emailMarketingConsent: consent}});
      const result = written?.customerEmailMarketingConsentUpdate;
      if (!result || result.userErrors.length || !successfulConsent(result.customer, 'SUBSCRIBED')) {
        return 'failed';
      }
      const tagged = await admin<{tagsAdd: {userErrors: unknown[]}}>(
        env,
        ADD_TAGS,
        {id: existing.id, tags},
      );
      if (tagged?.tagsAdd.userErrors.length !== 0) return 'failed';
      return alreadySubscribed ? 'already-subscribed' : 'subscribed';
    }
    const written = await admin<{
      customerCreate: {customer: Customer | null; userErrors: unknown[]};
    }>(env, CREATE_CUSTOMER, {input: {email, tags, emailMarketingConsent: consent}});
    const result = written?.customerCreate;
    return result && result.userErrors.length === 0 && successfulConsent(result.customer, 'SUBSCRIBED')
      ? 'subscribed'
      : 'failed';
  } catch {
    return 'failed';
  }
}

/** Remove consent in Shopify. Missing addresses are a generic successful no-op. */
export async function unsubscribeWithShopify(
  env: NewsletterEnv,
  email: string,
): Promise<'unsubscribed' | 'disabled' | 'failed'> {
  if (env.SHOPIFY_NEWSLETTER_WRITE_ENABLED !== '1') return 'disabled';
  try {
    const found = await admin<{customers: {nodes: Customer[]}}>(env, CUSTOMER_QUERY, {
      query: `email:"${email.replace(/"/g, '')}"`,
    });
    if (!found) return 'failed';
    const existing = exactCustomer(found.customers.nodes, email);
    if (!existing || existing.emailMarketingConsent?.marketingState === 'UNSUBSCRIBED') return 'unsubscribed';
    const written = await admin<{
      customerEmailMarketingConsentUpdate: {customer: Customer | null; userErrors: unknown[]};
    }>(env, UPDATE_CONSENT, {
      input: {
        customerId: existing.id,
        emailMarketingConsent: {
          marketingState: 'UNSUBSCRIBED',
          consentUpdatedAt: new Date().toISOString(),
        },
      },
    });
    const result = written?.customerEmailMarketingConsentUpdate;
    return result && result.userErrors.length === 0 && successfulConsent(result.customer, 'UNSUBSCRIBED')
      ? 'unsubscribed'
      : 'failed';
  } catch {
    return 'failed';
  }
}
