import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {createCart, fetchShopifyCatalog, getCart, productRating, storefrontEndpoint} from './shopify-storefront.ts';

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'open-drone-test.myshopify.com',
  SHOPIFY_STOREFRONT_TOKEN: 'test-token',
  SHOPIFY_STOREFRONT_API_VERSION: '2026-07',
  SHOPIFY_CHECKOUT_DOMAIN: 'checkout.opendrone.be',
  SHOPIFY_PRICES_INCLUDE_VAT: '1',
  SHOPIFY_PREVIEW_POLICY_JSON: JSON.stringify({
    'OPENRX-GEMINI': {saleMode: 'preorder', shipPromise: 'in about 10 weeks'},
  }),
} as Env;

function response(data: unknown): Response {
  return new Response(JSON.stringify({data}), {
    headers: {'Content-Type': 'application/json'},
  });
}

describe('Shopify Storefront catalog', () => {
  it('uses only a validated myshopify.com API origin', () => {
    assert.equal(
      storefrontEndpoint(ENV),
      'https://open-drone-test.myshopify.com/api/2026-07/graphql.json',
    );
    assert.throws(() =>
      storefrontEndpoint({...ENV, SHOPIFY_STORE_DOMAIN: 'attacker.test'}),
    );
  });

  it('maps Shopify variants onto the existing SKU catalog contract', async () => {
    let request: Request | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return response({
        products: {
          pageInfo: {hasNextPage: false},
          nodes: [
            {
              handle: 'openrx',
              title: 'OpenRX',
              description: 'Receiver',
              productType: 'ELRS Receiver',
              featuredImage: {url: 'https://cdn.shopify.com/rx.png'},
              images: {nodes: [{url: 'https://cdn.shopify.com/rx.png'}]},
              variants: {
                pageInfo: {hasNextPage: false},
                nodes: [
                  {
                    id: 'gid://shopify/ProductVariant/1',
                    title: 'Gemini',
                    sku: 'OPENRX-GEMINI',
                    availableForSale: true,
                    image: null,
                    price: {amount: '39.99', currencyCode: 'EUR'},
                    compareAtPrice: {amount: '49.99', currencyCode: 'EUR'},
                    selectedOptions: [{name: 'Model', value: 'Gemini'}],
                  },
                ],
              },
            },
          ],
        },
      });
    };
    const catalog = await fetchShopifyCatalog(ENV, fetcher);
    const variant = catalog.products[0].variants[0];

    assert.equal(variant.sku, 'OPENRX-GEMINI');
    assert.equal(variant.price, 39.99);
    assert.equal(variant.availability, 'preorder');
    assert.equal(variant.ship_promise, 'in about 10 weeks');
    assert.equal(variant.merchandise_id, 'gid://shopify/ProductVariant/1');
    assert.equal(variant.cart_add_url, '/api/shopify/cart?sku=OPENRX-GEMINI&qty=1');
    assert.equal(request?.headers.get('x-shopify-storefront-access-token'), 'test-token');
    assert.equal(request?.redirect, 'manual');
  });

  it('fails closed when a SKU is missing or duplicated', async () => {
    const fetcher: typeof fetch = async () =>
      response({
        products: {
          pageInfo: {hasNextPage: false},
          nodes: [
            {
              handle: 'bad', title: 'Bad', description: '', productType: '',
              featuredImage: null, images: {nodes: []},
              variants: {pageInfo: {hasNextPage: false}, nodes: [{
                id: 'gid://shopify/ProductVariant/1', title: 'Default', sku: '',
                availableForSale: true, image: null,
                price: {amount: '1.00', currencyCode: 'EUR'}, compareAtPrice: null,
                selectedOptions: [],
              }]},
            },
          ],
        },
      });
    await assert.rejects(fetchShopifyCatalog(ENV, fetcher), /missing or duplicate SKU/);
  });

  it('does not infer VAT inclusion or sale mode from Shopify fields', async () => {
    const fetcher: typeof fetch = async () => response({
      products: {pageInfo: {hasNextPage: false}, nodes: []},
    });
    await assert.rejects(
      fetchShopifyCatalog({...ENV, SHOPIFY_PRICES_INCLUDE_VAT: ''}, fetcher),
      /SHOPIFY_PRICES_INCLUDE_VAT|VAT-inclusive pricing/,
    );
  });
});

describe('Shopify hosted checkout handoff', () => {
  it('fails closed when the cart line query is incomplete', async () => {
    const id = 'gid://shopify/Cart/test?key=secret';
    await assert.rejects(
      getCart(ENV, id, async () => response({cart: {
        id,
        checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/abc',
        lines: {pageInfo: {hasNextPage: true}, nodes: []},
      }})),
      /supported line page/,
    );
  });

  it('rejects malformed quantities and merchandise identities in cart responses', async () => {
    const id = 'gid://shopify/Cart/test?key=secret';
    await assert.rejects(
      getCart(ENV, id, async () => response({cart: {
        id,
        checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/abc',
        lines: {
          pageInfo: {hasNextPage: false},
          nodes: [{merchandise: {id: ''}, quantity: 0}],
        },
      }})),
      /invalid lines/,
    );
  });
  it('sends only server-resolved merchandise ids and accepts an allowed checkout origin', async () => {
    let variables: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      variables = (JSON.parse(String(init?.body)) as {
        variables: Record<string, unknown>;
      }).variables;
      return response({
        cartCreate: {
          cart: {id: 'gid://shopify/Cart/test?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/abc', totalQuantity: 0, cost: {subtotalAmount: {amount: '0.0', currencyCode: 'EUR'}, totalAmount: {amount: '0.0', currencyCode: 'EUR'}}, lines: {pageInfo: {hasNextPage: false}, nodes: []}},
          userErrors: [],
          warnings: [],
        },
      });
    };
    const url = (await createCart(
      ENV,
      [{merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 2}],
      fetcher,
    )).checkoutUrl;
    assert.equal(url, 'https://checkout.opendrone.be/checkouts/cn/abc');
    assert.deepEqual(variables, {input: {lines: [{
      merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 2,
    }]}});
  });

  it('rejects checkout redirects to an unexpected host', async () => {
    const fetcher: typeof fetch = async () => response({
      cartCreate: {
        cart: {id: 'gid://shopify/Cart/test?key=secret', checkoutUrl: 'https://attacker.test/checkout', totalQuantity: 0, cost: {subtotalAmount: {amount: '0.0', currencyCode: 'EUR'}, totalAmount: {amount: '0.0', currencyCode: 'EUR'}}, lines: {pageInfo: {hasNextPage: false}, nodes: []}},
        userErrors: [], warnings: [],
      },
    });
    await assert.rejects(
      createCart(ENV, [{merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1}], fetcher),
      /unexpected origin/,
    );
  });

  it('rejects checkout URLs with credentials or a non-default port', async () => {
    for (const checkoutUrl of [
      'https://user:pass@checkout.opendrone.be/checkouts/x',
      'https://checkout.opendrone.be:8443/checkouts/x',
    ]) {
      const fetcher: typeof fetch = async () => response({
        cartCreate: {cart: {id: 'gid://shopify/Cart/test?key=secret', checkoutUrl, totalQuantity: 0, cost: {subtotalAmount: {amount: '0.0', currencyCode: 'EUR'}, totalAmount: {amount: '0.0', currencyCode: 'EUR'}}, lines: {pageInfo: {hasNextPage: false}, nodes: []}}, userErrors: [], warnings: []},
      });
      await assert.rejects(
        createCart(ENV, [{merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1}], fetcher),
        /unexpected origin/,
      );
    }
  });

  it('rejects Shopify cart warnings instead of silently adjusting lines', async () => {
    const fetcher: typeof fetch = async () => response({
      cartCreate: {
        cart: {id: 'gid://shopify/Cart/test?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/abc', totalQuantity: 0, cost: {subtotalAmount: {amount: '0.0', currencyCode: 'EUR'}, totalAmount: {amount: '0.0', currencyCode: 'EUR'}}, lines: {pageInfo: {hasNextPage: false}, nodes: []}},
        userErrors: [], warnings: [{message: 'Quantity adjusted'}],
      },
    });
    await assert.rejects(
      createCart(ENV, [{merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1}], fetcher),
      /cartCreate failed/,
    );
  });
});

describe('productRating', () => {
  it('reads the rating metafield JSON and the count', () => {
    assert.deepEqual(
      productRating('{"value":"4.7","scale_min":"1.0","scale_max":"5.0"}', '12'),
      {average: 4.7, count: 12},
    );
  });

  it('accepts a bare number, in case the app writes one', () => {
    assert.deepEqual(productRating('4.5', '3'), {average: 4.5, count: 3});
  });

  it('is null without reviews, with a zero count, or on junk', () => {
    assert.equal(productRating(undefined, undefined), null);
    assert.equal(productRating('{"value":"4.7"}', undefined), null);
    assert.equal(productRating('{"value":"4.7"}', '0'), null);
    assert.equal(productRating('not json', '5'), null);
    assert.equal(productRating('{"value":"0"}', '5'), null);
  });
});
