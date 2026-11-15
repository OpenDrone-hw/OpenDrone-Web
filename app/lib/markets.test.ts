import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {MARKET_COLUMNS, marketRows} from './markets.ts';
import {PREORDER_SHIPS_BY, shipByDate} from './geo-availability.ts';
import {regionFor} from './region.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const table = (rows: ReturnType<typeof marketRows>) => rows.map((r) => [r.market, ...MARKET_COLUMNS.map(([key]) => r[key])]);

/**
 * /markets ("Where we ship") is generated from the region resolver and the
 * shipping data. The snapshot below is what the page says today; a change to
 * a market, a tax rule, a lane or a rate shows up here first.
 */
describe('/markets: generated from the region data', () => {
  it('snapshot while pre-orders are open and the US is sold direct', () => {
    assert.deepEqual(table(marketRows(9.95)), [
      ['eu', 'EU countries (27)', 'EUR', 'VAT included', 'Yes', 'Yes', 'From Belgium, €8.50 to €39.95; in stock ships in days, pre-orders ship by 31 March 2027'],
      ['us', 'United States', 'USD', 'Duties included', 'No', 'Yes', 'Flat US$9.95; pre-orders ship by 31 March 2027'],
      ['import', 'United Kingdom, Switzerland and Norway', 'EUR', 'Base price, no EU VAT; import taxes on delivery', 'No', 'Yes', 'From Belgium, rate at checkout; pre-orders ship by 31 March 2027'],
      ['world', 'Rest of the world (181 countries)', 'EUR', 'Base price, no EU VAT; import taxes on delivery', 'No', 'Yes', 'From Belgium, rate at checkout; pre-orders ship by 31 March 2027'],
      ['none', 'Countries not served yet (31)', '-', '-', 'No', 'No', 'Not yet'],
    ]);
  });

  it('snapshot of the ordinary shop (batch 2 landed, US closed): stock everywhere, no pre-order', () => {
    assert.deepEqual(table(marketRows(null, true)), [
      ['eu', 'EU countries (27)', 'EUR', 'VAT included', 'Yes', 'No', 'From Belgium, €8.50 to €39.95; in stock ships in days'],
      ['import', 'United Kingdom, Switzerland and Norway', 'EUR', 'Base price, no EU VAT; import taxes on delivery', 'Yes', 'No', 'From Belgium, rate at checkout; ships from stock'],
      ['world', 'Rest of the world (181 countries)', 'EUR', 'Base price, no EU VAT; import taxes on delivery', 'Yes', 'No', 'From Belgium, rate at checkout; ships from stock'],
      ['none', 'Countries not served yet (32)', '-', '-', 'No', 'No', 'Not yet'],
    ]);
  });

  it('every row agrees with the resolver for a country of that market', () => {
    const sample: Record<string, string> = {eu: 'DE', us: 'US', import: 'GB', world: 'AU'};
    for (const row of marketRows(9.95)) {
      if (row.market === 'none') continue;
      const region = regionFor(sample[row.market], 'choice', true);
      assert.equal(region.market, row.market);
      assert.equal(row.currency, region.currency);
      assert.equal(row.inStock, region.lanes.buyNow ? 'Yes' : 'No');
      assert.equal(row.preorder, region.lanes.preorder ? 'Yes' : 'No');
    }
  });

  it('an EU country not approved for sale moves to "not served yet"', () => {
    // An empty registrations file: no EU country is approved for consumer sale.
    const rows = marketRows(9.95, false, {});
    assert.equal(rows.find((r) => r.market === 'eu'), undefined);
    assert.equal(rows.find((r) => r.market === 'none')!.who, 'Countries not served yet (58)');
  });

  it('the ship-by date is the campaign one', () => {
    const config = JSON.parse(read('../../content/preorders.json')) as {shipsBy: string};
    assert.equal(PREORDER_SHIPS_BY, config.shipsBy);
    assert.equal(shipByDate('en'), '31 March 2027');
  });
});

describe('/markets: wired into the site', () => {
  const page = read('../routes/markets.tsx');
  it('renders the generated rows, the wholesale line, the pre-order terms and the launch-list form', () => {
    assert.match(page, /const rows = marketRows\(usRate, ordinary\);/);
    assert.match(page, /to="\/wholesale"/);
    assert.match(page, /to="\/preorder"/);
    assert.match(page, /<NewsletterSignup/);
    const copy = JSON.parse(read('../../content/copy/markets.json')) as Record<string, string>;
    assert.equal(copy.title, 'Where we ship');
    // States only what stays true: shops can apply, the link goes to /wholesale. No stock or ship claim.
    assert.equal(copy.wholesale, 'Shops and dealers can apply for wholesale.');
    assert.match(page, /to="\/wholesale"/);
    assert.equal(copy.notify_title, 'Not shipping to your country yet? Get notified.');
    for (const v of Object.values(copy)) assert.doesNotMatch(v, /—/, 'no em dashes');
  });
  it('is linked from the footer next to Shipping, the sitemap, and the price line\'s tax wording', () => {
    assert.match(read('../components/Footer.tsx'), /\{to: '\/shipping', copy: 'nav_shipping'\},\s+\{to: '\/markets', copy: 'nav_markets'\}/);
    assert.match(read('../routes/[sitemap.xml].tsx'), /'\/markets'/);
    assert.match(read('../routes/products.$handle.tsx'), /<Link prefetch="intent" to="\/markets" className="product-buy-vat product-buy-vat-link">\{vatNote\}<\/Link>/);
  });
});
