import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {checkoutOpen} from './shopify-cart-action.ts';

const APP = {COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example'} as const;

describe('checkoutOpen', () => {
  it('on Shopify needs both the write flag and the coming-soon flag off', () => {
    assert.equal(checkoutOpen({SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0'} as never), true);
    assert.equal(checkoutOpen({SHOPIFY_CHECKOUT_WRITE_ENABLED: '0', PUBLIC_COMING_SOON: '0'} as never), false);
    assert.equal(checkoutOpen({SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '1'} as never), false);
  });
  it('on the app ignores the Shopify write flag, so turning it off at the switch keeps the shop open', () => {
    assert.equal(checkoutOpen({...APP, SHOPIFY_CHECKOUT_WRITE_ENABLED: '0', PUBLIC_COMING_SOON: '0'} as never), true);
    assert.equal(checkoutOpen({...APP, SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '1'} as never), false);
  });
});
