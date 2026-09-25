import assert from 'node:assert/strict';
import {afterEach, describe, it, mock} from 'node:test';
import {subscribeWithShopify, unsubscribeWithShopify} from './shopify-newsletter.ts';

const ENV = {
  SHOPIFY_NEWSLETTER_WRITE_ENABLED: '1',
  SHOPIFY_STORE_DOMAIN: 'store.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'test-token',
  SHOPIFY_ADMIN_API_VERSION: '2026-07',
};
afterEach(() => mock.restoreAll());
const customer = (state: string, email = 'pilot@example.com') => ({
  id: 'gid://shopify/Customer/1', email,
  emailMarketingConsent: {marketingState: state},
});

describe('Shopify newsletter ownership', () => {
  it('is write-disabled independently from catalog preview', async () => {
    let fetched = false; mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error(); });
    assert.equal(await subscribeWithShopify({...ENV, SHOPIFY_NEWSLETTER_WRITE_ENABLED: undefined}, 'pilot@example.com'), 'disabled');
    assert.equal(fetched, false);
  });

  it('does not silently resubscribe an exact Shopify unsubscribe', async () => {
    let calls = 0; mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({data: {customers: {nodes: [customer('UNSUBSCRIBED')]}}}); });
    assert.equal(await subscribeWithShopify(ENV, 'pilot@example.com'), 'suppressed');
    assert.equal(calls, 1);
  });

  it('never mutates the first fuzzy Shopify search result', async () => {
    const bodies: string[] = [];
    mock.method(globalThis, 'fetch', async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      bodies.push(String(init?.body));
      return Response.json({data: {customers: {nodes: [customer('NOT_SUBSCRIBED', 'other@example.com')]}}});
    });
    assert.equal(await subscribeWithShopify(ENV, 'pilot@example.com'), 'failed');
    assert.equal(bodies.length, 2);
    assert.match(bodies[1], /NewsletterCustomerCreate/);
  });

  it('requires returned identity and expected consent after update', async () => {
    let call = 0;
    mock.method(globalThis, 'fetch', async () => ++call === 1
      ? Response.json({data: {customers: {nodes: [customer('NOT_SUBSCRIBED')]}}})
      : Response.json({data: {customerEmailMarketingConsentUpdate: {customer: null, userErrors: []}}}));
    assert.equal(await subscribeWithShopify(ENV, 'pilot@example.com'), 'failed');
  });

  it('adds newsletter and product-interest tags without replacing existing tags', async () => {
    const bodies: Array<{query: string; variables: Record<string, unknown>}> = [];
    mock.method(globalThis, 'fetch', async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      if (body.query.includes('NewsletterCustomerByEmail')) {
        return Response.json({data: {customers: {nodes: [customer('NOT_SUBSCRIBED')]}}});
      }
      if (body.query.includes('NewsletterConsentUpdate')) {
        return Response.json({data: {customerEmailMarketingConsentUpdate: {customer: customer('SUBSCRIBED'), userErrors: []}}});
      }
      return Response.json({data: {tagsAdd: {userErrors: []}}});
    });
    assert.equal(
      await subscribeWithShopify(ENV, 'pilot@example.com', 'openrx'),
      'subscribed',
    );
    assert.deepEqual(bodies[2].variables.tags, ['newsletter', 'notify-openrx']);
    assert.match(bodies[2].query, /tagsAdd/);
  });

  it('puts native tags on a newly created customer', async () => {
    const bodies: Array<{query: string; variables: {input?: {tags?: string[]}}}> = [];
    mock.method(globalThis, 'fetch', async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      return body.query.includes('NewsletterCustomerByEmail')
        ? Response.json({data: {customers: {nodes: []}}})
        : Response.json({data: {customerCreate: {customer: customer('SUBSCRIBED'), userErrors: []}}});
    });
    assert.equal(await subscribeWithShopify(ENV, 'pilot@example.com'), 'subscribed');
    assert.deepEqual(bodies[1].variables.input?.tags, ['newsletter']);
  });

  it('tags a subscriber from a country not sold direct with that country', async () => {
    const bodies: Array<{query: string; variables: {input?: {tags?: string[]}}}> = [];
    mock.method(globalThis, 'fetch', async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
      bodies.push(body);
      return body.query.includes('NewsletterCustomerByEmail')
        ? Response.json({data: {customers: {nodes: []}}})
        : Response.json({data: {customerCreate: {customer: customer('SUBSCRIBED'), userErrors: []}}});
    });
    assert.equal(await subscribeWithShopify(ENV, 'pilot@example.com', 'openrx', 'us'), 'subscribed');
    assert.deepEqual(bodies[1].variables.input?.tags, ['newsletter', 'notify-openrx', 'country-US']);
    bodies.length = 0;
    await subscribeWithShopify(ENV, 'pilot@example.com', undefined, 'NL');
    // An open EU country is sold direct and gets no country tag.
    assert.deepEqual(bodies[1].variables.input?.tags, ['newsletter']);
    for (const country of ['RU', null, 'ZZ']) {
      bodies.length = 0;
      await subscribeWithShopify(ENV, 'pilot@example.com', undefined, country);
      assert.deepEqual(bodies[1].variables.input?.tags, ['newsletter'], String(country));
    }
  });

  it('unsubscribes the exact customer and verifies the returned state', async () => {
    let call = 0;
    mock.method(globalThis, 'fetch', async () => ++call === 1
      ? Response.json({data: {customers: {nodes: [customer('SUBSCRIBED')]}}})
      : Response.json({data: {customerEmailMarketingConsentUpdate: {customer: customer('UNSUBSCRIBED'), userErrors: []}}}));
    assert.equal(await unsubscribeWithShopify(ENV, 'pilot@example.com'), 'unsubscribed');
  });
});
