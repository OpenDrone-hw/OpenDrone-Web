const DEFAULT_ADMIN_API_VERSION = '2026-07';
export const SHIPPING_LINE_PREFIX = 'OpenDrone shipping';

export const ORDER_FOR_SHIPPING_QUERY = `#graphql
  query OpenDroneOrderForShipping($id: ID!) {
    order(id: $id) {
      id name currencyCode cancelledAt displayFinancialStatus displayFulfillmentStatus
      shippingLines(first: 50) {
        nodes { id title originalPriceSet { shopMoney { amount currencyCode } } }
      }
    }
  }
`;

export const ORDER_EDIT_BEGIN = `#graphql
  mutation OpenDroneOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id }
      userErrors { field message }
    }
  }
`;

export const ORDER_ADD_SHIPPING = `#graphql
  mutation OpenDroneOrderAddShipping($id: ID!, $shippingLine: OrderEditAddShippingLineInput!) {
    orderEditAddShippingLine(id: $id, shippingLine: $shippingLine) {
      calculatedOrder { id }
      calculatedShippingLine { id title }
      userErrors { field message }
    }
  }
`;

export const ORDER_EDIT_COMMIT = `#graphql
  mutation OpenDroneOrderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id name }
      userErrors { field message }
    }
  }
`;

export type ShippingInvoiceEnv = {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_ADMIN_API_TOKEN?: string;
  SHOPIFY_ADMIN_API_VERSION?: string;
  SHOPIFY_SHIPPING_INVOICE_WRITE_ENABLED?: string;
};

export type ShippingInvoiceInput = {
  orderId: string;
  amount: string;
  service: string;
  reference: string;
};

type Order = {
  id: string;
  name: string;
  currencyCode: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  shippingLines: {nodes: Array<{title: string}>};
};

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is not configured`);
  return trimmed;
}

export function adminEndpoint(env: ShippingInvoiceEnv): string {
  const host = required(env.SHOPIFY_STORE_DOMAIN, 'SHOPIFY_STORE_DOMAIN')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i.test(host)) {
    throw new Error('SHOPIFY_STORE_DOMAIN must be a myshopify.com host');
  }
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_ADMIN_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) throw new Error('invalid Admin API version');
  return `https://${host}/admin/api/${version}/graphql.json`;
}

function validateInput(input: ShippingInvoiceInput) {
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(input.orderId)) throw new Error('invalid Shopify order GID');
  if (!/^\d+(?:\.\d{1,2})?$/.test(input.amount) || Number(input.amount) <= 0) throw new Error('amount must be a positive decimal with at most two places');
  if (!/^[A-Za-z0-9][A-Za-z0-9 .()+\/-]{2,60}$/.test(input.service)) throw new Error('invalid shipping service');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,60}$/.test(input.reference)) throw new Error('invalid unique reference');
}

async function adminRequest<T>(env: ShippingInvoiceEnv, query: string, variables: Record<string, unknown>, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(adminEndpoint(env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': required(env.SHOPIFY_ADMIN_API_TOKEN, 'SHOPIFY_ADMIN_API_TOKEN'),
    },
    body: JSON.stringify({query, variables}),
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`Shopify Admin API returned ${response.status}`);
  const result = await response.json() as {data?: T; errors?: Array<{message: string}>};
  if (result.errors?.length || !result.data) throw new Error('Shopify Admin API rejected the operation');
  return result.data;
}

function rejectUserErrors(errors: Array<{message: string}> | undefined, operation: string) {
  if (errors?.length) throw new Error(`${operation}: ${errors.map(({message}) => message).join('; ')}`);
}

export async function inspectShippingInvoice(env: ShippingInvoiceEnv, input: ShippingInvoiceInput, fetcher: typeof fetch = fetch) {
  validateInput(input);
  const data = await adminRequest<{order: Order | null}>(env, ORDER_FOR_SHIPPING_QUERY, {id: input.orderId}, fetcher);
  const order = data.order;
  if (!order) throw new Error('order not found');
  if (order.cancelledAt) throw new Error('cancelled orders cannot receive shipping invoices');
  if (order.currencyCode !== 'EUR') throw new Error('shipping invoice requires an EUR order');
  if (order.displayFulfillmentStatus === 'FULFILLED') throw new Error('fulfilled orders cannot receive shipping invoices');
  const label = `${SHIPPING_LINE_PREFIX}: ${input.service} [${input.reference}]`;
  if (order.shippingLines.nodes.some(({title}) => title === label || title.includes(`[${input.reference}]`))) {
    throw new Error('shipping invoice reference already exists on this order');
  }
  return {orderId: order.id, orderName: order.name, amount: input.amount, currency: 'EUR', label};
}

export async function sendShippingInvoice(env: ShippingInvoiceEnv, input: ShippingInvoiceInput, fetcher: typeof fetch = fetch) {
  if (env.SHOPIFY_SHIPPING_INVOICE_WRITE_ENABLED !== '1') throw new Error('SHOPIFY_SHIPPING_INVOICE_WRITE_ENABLED is not enabled');
  const plan = await inspectShippingInvoice(env, input, fetcher);
  const begun = await adminRequest<{orderEditBegin: {calculatedOrder: {id: string} | null; userErrors: Array<{message: string}>}}>(env, ORDER_EDIT_BEGIN, {id: input.orderId}, fetcher);
  rejectUserErrors(begun.orderEditBegin.userErrors, 'orderEditBegin');
  const calculatedId = begun.orderEditBegin.calculatedOrder?.id;
  if (!calculatedId) throw new Error('orderEditBegin returned no calculated order');
  const added = await adminRequest<{orderEditAddShippingLine: {userErrors: Array<{message: string}>}}>(env, ORDER_ADD_SHIPPING, {
    id: calculatedId,
    shippingLine: {title: plan.label, price: {amount: input.amount, currencyCode: 'EUR'}},
  }, fetcher);
  rejectUserErrors(added.orderEditAddShippingLine.userErrors, 'orderEditAddShippingLine');
  const committed = await adminRequest<{orderEditCommit: {order: {id: string; name: string} | null; userErrors: Array<{message: string}>}}>(env, ORDER_EDIT_COMMIT, {
    id: calculatedId,
    notifyCustomer: true,
    staffNote: `Shipping calculated for packed preorder. Reference ${input.reference}.`,
  }, fetcher);
  rejectUserErrors(committed.orderEditCommit.userErrors, 'orderEditCommit');
  if (!committed.orderEditCommit.order) throw new Error('orderEditCommit returned no order');
  return {...plan, sent: true as const};
}
