import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {CATALOG_PERSIST_MAX_MS, CATALOG_STALE_MS, CATALOG_TTL_MS, clearCatalogMemo, memoCatalog} from './catalog-memo.ts';
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

  it('serves a stale catalog and refreshes behind the response with waitUntil', async () => {
    let calls = 0;
    let t = 0;
    const load = async () => catalog(`read-${++calls}`);
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => void pending.push(p);
    await memoCatalog('default', load, () => t, waitUntil);
    t = CATALOG_TTL_MS + 1;
    const stale = await memoCatalog('default', load, () => t, waitUntil);
    assert.equal(stale.products[0].handle, 'read-1');
    await Promise.all(pending);
    const next = await memoCatalog('default', load, () => t, waitUntil);
    assert.equal(next.products[0].handle, 'read-2');
    t = CATALOG_TTL_MS + 1 + CATALOG_STALE_MS;
    const old = await memoCatalog('default', load, () => t, waitUntil);
    assert.equal(old.products[0].handle, 'read-3');
  });

  it('a cold isolate answers from the persisted copy and refreshes behind', async () => {
    const written: string[] = [];
    const persist = {
      read: async () => ({catalog: catalog('kept'), fetchedAt: 0}),
      write: async (_m: string, c: Catalog) => void written.push(c.products[0].handle),
    };
    const bg: Promise<unknown>[] = [];
    let calls = 0;
    const load = async () => catalog(`read-${++calls}`);
    const got = await memoCatalog('default', load, () => CATALOG_STALE_MS + 1, (p) => bg.push(p), persist);
    assert.equal(got.products[0].handle, 'kept');
    await Promise.all(bg);
    assert.deepEqual(written, ['read-1']);
  });

  it('ignores a persisted copy older than the limit and reads Shopify', async () => {
    const persist = {read: async () => ({catalog: catalog('old'), fetchedAt: 0}), write: async () => {}};
    const got = await memoCatalog('default', async () => catalog('new'), () => CATALOG_PERSIST_MAX_MS, () => {}, persist);
    assert.equal(got.products[0].handle, 'new');
  });
});
