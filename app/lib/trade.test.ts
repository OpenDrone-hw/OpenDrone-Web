import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {validateTradeApplication, submitTradeApplication, type TradeApplication} from './trade.ts';

const ENV = {SHOPIFY_STORE_DOMAIN: 'test.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'test-token', SHOPIFY_TRADE_WRITE_ENABLED: '1'};
type ApiBody = {query: string; variables: {query: string; input: {company: {name: string; externalId: string; note: string}; companyLocation: {name: string}}}};
const fields = {company: 'Test shop', contactName: 'Test Buyer', email: 'buyer@example.com', country: 'BE', site: 'shop.example', note: 'Interested in frames.'};
function form(values = fields) { const f = new FormData(); for (const [key, value] of Object.entries(values)) f.set(key, value); return f; }
function application(): TradeApplication { const result = validateTradeApplication(form()); if (!result.ok) throw new Error('Invalid fixture'); return result.application; }
const answer = (value: unknown) => new Response(JSON.stringify({data: value}), {headers: {'Content-Type': 'application/json'}});
const found = (nodes: unknown[] = []) => ({companies: {nodes, pageInfo: {hasNextPage: false, endCursor: null}}});

describe('wholesale application validation', () => {
  it('accepts a physical shop without a website and without order or tax details', () => {
    assert.equal(validateTradeApplication(form({...fields, site: '', note: ''})).ok, true);
  });
  it('rejects unsupported destinations and malformed or overlong fields', () => {
    for (const [key, value] of [['country', 'GB'], ['company', 'x'], ['company', 'shop\nother'], ['contactName', ''], ['email', 'wrong'], ['note', 'x'.repeat(2001)], ['site', 'javascript:alert(1)'], ['site', 'https://user:password@shop.example']]) {
      assert.equal(validateTradeApplication(form({...fields, [key]: value})).ok, false, key);
    }
  });
});

describe('Shopify company applications', () => {
  it('fails closed without the explicit write switch or token', async () => {
    const never = (async () => { throw new Error('must not call Shopify'); }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication({...ENV, SHOPIFY_TRADE_WRITE_ENABLED: '0'}, application(), never), {ok: false, reason: 'not_configured'});
    assert.deepEqual(await submitTradeApplication({...ENV, SHOPIFY_ADMIN_API_TOKEN: ''}, application(), never), {ok: false, reason: 'not_configured'});
  });
  it('saves the request in Companies with no buyer, permissions, tax exemptions or price changes', async () => {
    const calls: ApiBody[] = [];
    const api = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ApiBody; calls.push(body);
      if (body.query.includes('query WholesaleApplication')) return answer(found());
      const input = body.variables.input;
      assert.equal(input.company.name, fields.company);
      assert.match(input.company.note, /buyer@example.com/);
      assert.match(input.company.note, /Pending review/);
      assert.match(input.company.note, /Interested in frames/);
      assert.deepEqual(Object.keys(input).sort(), ['company', 'companyLocation']);
      assert.deepEqual(input.companyLocation, {name: 'Belgium'});
      return answer({companyCreate: {company: {id: 'gid://shopify/Company/1', externalId: input.company.externalId}, userErrors: []}});
    }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    assert.equal(calls.length, 2);
  });
  it('finds repeated applications without replacing the reviewed company', async () => {
    let mutations = 0;
    const api = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ApiBody;
      if (body.query.includes('mutation')) mutations++;
      const externalId = body.variables.query.split('"')[1];
      return answer(found([{id: 'gid://shopify/Company/1', externalId}]));
    }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    assert.equal(mutations, 0);
  });
  it('ignores broader search results and does not mistake them for this application', async () => {
    let mutations = 0;
    const api = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ApiBody;
      if (body.query.includes('query')) return answer(found([{id: 'other', externalId: 'other'}]));
      mutations++;
      return answer({companyCreate: {company: {id: 'new', externalId: body.variables.input.company.externalId}, userErrors: []}});
    }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    assert.equal(mutations, 1);
  });
  it('recovers a saved request after a mutation timeout without writing twice', async () => {
    let externalId = ''; let mutations = 0;
    const api = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ApiBody;
      if (body.query.includes('query')) return answer(found(externalId ? [{id: 'saved', externalId}] : []));
      mutations++; externalId = body.variables.input.company.externalId;
      throw new Error('network timeout after Shopify saved');
    }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    assert.equal(mutations, 1);
  });
  it('never confirms an unrecorded request when Shopify rejects or is unavailable', async () => {
    for (const mode of ['rejected', 'offline']) {
      const api = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as ApiBody;
        if (mode === 'offline') throw new Error('offline');
        if (body.query.includes('query')) return answer(found());
        return answer({companyCreate: {company: null, userErrors: [{code: 'INVALID', message: 'invalid'}]}});
      }) as typeof fetch;
      assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: false, reason: 'unavailable'});
    }
  });
  it('recognizes a retry after capitalization, spacing or message changes', async () => {
    const saved = new Map<string, {id: string; externalId: string}>();
    let mutations = 0;
    const api = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ApiBody;
      if (body.query.includes('query')) {
        const company = saved.get(body.variables.query.split('"')[1]);
        return answer(found(company ? [company] : []));
      }
      mutations++;
      const company = {id: 'saved', externalId: body.variables.input.company.externalId};
      saved.set(company.externalId, company);
      return answer({companyCreate: {company, userErrors: []}});
    }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    const retry = validateTradeApplication(form({...fields, company: ' TEST   SHOP ', email: 'BUYER@EXAMPLE.COM', note: 'Updated message'}));
    assert.ok(retry.ok);
    assert.deepEqual(await submitTradeApplication(ENV, retry.application, api), {ok: true});
    assert.equal(mutations, 1);
  });
});
