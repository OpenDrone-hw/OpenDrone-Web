import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {CATALOG_TTL_MS, clearCatalogMemo, memoCatalog} from './catalog-memo.ts';
import type {Catalog} from './catalog.ts';

const catalog = (tag: string) => ({currency: 'EUR', products: [{handle: tag}]}) as unknown as Catalog;

describe('memoCatalog', () => {
  beforeEach(() => clearCatalogMemo());

  it('reads Shopify once per market within the minute, again after it', async () => {
    let calls = 0;
    let t = 0;
    const load = async () => {
      calls += 1;
      return catalog(`read-${calls}`);
    };
    await memoCatalog('default', load, () => t);
    t = CATALOG_TTL_MS - 1;
    const second = await memoCatalog('default', load, () => t);
    assert.equal(calls, 1);
    assert.equal(second.products[0].handle, 'read-1');
    t = CATALOG_TTL_MS;
    const third = await memoCatalog('default', load, () => t);
    assert.equal(calls, 2);
    assert.equal(third.products[0].handle, 'read-2');
  });

  it('keeps markets apart', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return catalog('x');
    };
    await memoCatalog('default', load, () => 0);
    await memoCatalog('US', load, () => 0);
    assert.equal(calls, 2);
  });

  it('hands each caller its own copy', async () => {
    const load = async () => catalog('shared');
    const a = await memoCatalog('default', load, () => 0);
    a.products[0].handle = 'changed';
    const b = await memoCatalog('default', load, () => 0);
    assert.equal(b.products[0].handle, 'shared');
  });

  it('never keeps a failed read', async () => {
    let calls = 0;
    const failing = async (): Promise<Catalog> => {
      calls += 1;
      throw new Error('shopify down');
    };
    await assert.rejects(memoCatalog('default', failing, () => 0));
    await assert.rejects(memoCatalog('default', failing, () => 0));
    assert.equal(calls, 2);
  });
});
