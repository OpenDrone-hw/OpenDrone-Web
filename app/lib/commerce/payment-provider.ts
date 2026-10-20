/**
 * Express wallets (Apple Pay, Google Pay) at the top of the checkout. They need a payment provider and its key, so
 * the buttons render only when EXPRESS_PAY_PROVIDER names a provider with express support and its publishable key
 * is set. With neither (the test shop, production today) nothing is drawn: no fake button.
 *
 * Turn on: EXPRESS_PAY_PROVIDER=stripe and STRIPE_PUBLISHABLE_KEY=pk_... (a Worker var; a publishable key is public).
 * Apple Pay in addition needs the domain registered with the provider and its merchant validation endpoint in the
 * app; until then only Google Pay answers (see ExpressCheckout.tsx).
 */
export type ExpressConfig = {provider: 'stripe'; publishableKey: string; methods: PaymentMethodData[]};
export type PaymentMethodData = {supportedMethods: string; data?: Record<string, unknown>};

export type ExpressEnv = {EXPRESS_PAY_PROVIDER?: string; STRIPE_PUBLISHABLE_KEY?: string};

/** What the browser needs to offer wallets, or null when no configured provider supports express. */
export function expressConfig(env: ExpressEnv): ExpressConfig | null {
  const key = env.STRIPE_PUBLISHABLE_KEY ?? '';
  if ((env.EXPRESS_PAY_PROVIDER ?? '').toLowerCase() !== 'stripe' || !/^pk_(test|live)_/.test(key)) return null;
  return {
    provider: 'stripe',
    publishableKey: key,
    methods: [
      {
        supportedMethods: 'https://google.com/pay',
        data: {
          environment: key.startsWith('pk_live_') ? 'PRODUCTION' : 'TEST',
          apiVersion: 2,
          apiVersionMinor: 0,
          allowedPaymentMethods: [
            {
              type: 'CARD',
              parameters: {allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'], allowedCardNetworks: ['MASTERCARD', 'VISA']},
              tokenizationSpecification: {type: 'PAYMENT_GATEWAY', parameters: {gateway: 'stripe', 'stripe:version': '2020-08-27', 'stripe:publishableKey': key}},
            },
          ],
        },
      },
    ],
  };
}

export type ExpressResult = {
  name: string;
  email: string;
  phone: string;
  address: {line1: string; line2: string; postal_code: string; city: string; country: string};
};

/** The Payment Request API's shipping address and payer details as the form's fields. */
export function fromPaymentResponse(res: {
  payerName?: string | null;
  payerEmail?: string | null;
  payerPhone?: string | null;
  shippingAddress?: {addressLine?: readonly string[]; postalCode?: string; city?: string; country?: string; recipient?: string; phone?: string} | null;
}): ExpressResult {
  const a = res.shippingAddress ?? {};
  const lines = a.addressLine ?? [];
  return {
    name: res.payerName || a.recipient || '',
    email: res.payerEmail ?? '',
    phone: res.payerPhone || a.phone || '',
    address: {line1: lines[0] ?? '', line2: lines.slice(1).join(', '), postal_code: a.postalCode ?? '', city: a.city ?? '', country: (a.country ?? '').toUpperCase()},
  };
}
