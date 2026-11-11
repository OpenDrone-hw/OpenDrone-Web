import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {EU_COUNTRY_CODES} from './eu-countries.ts';
import {
  GEO_AVAILABILITY_COPY,
  availabilityBannerHiddenOn,
  GEO_BANNER_COPY,
  INTL_AVAILABILITY_STARTS,
  batchOnePromises,
  geoAvailabilityRegion,
  geoBannerLines,
  geoOfferAvailability,
  geoBarText,
  geoDutiesNote,
  geoInStock,
  stockRegion,
  geoShipText,
  hasBatchOne,
  offerRegionRestriction,
  offerAvailability,
} from './geo-availability.ts';
import {visitorCountry} from './visitor-country.ts';

const PREORDERS = JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')) as {
  pendingShips: string;
  skus: Record<string, {batches: Array<{paid?: boolean; ships?: string}>}>;
};
const req = (country?: string) => new Request('https://opendrone.be/products/openesc', {headers: country ? {'CF-IPCountry': country} : {}});

describe('geoAvailabilityRegion', () => {
  it('puts every EU member state in the EU and nothing else', () => {
    for (const c of EU_COUNTRY_CODES) assert.equal(geoAvailabilityRegion(c), 'eu', c);
    // UK, Switzerland and Norway get batch 1 with duties on delivery; the US is on hold.
    for (const c of ['GB', 'CH', 'NO']) assert.equal(geoAvailabilityRegion(c), 'import', c);
    assert.equal(geoAvailabilityRegion('US'), 'us');
    // US sales open: the US reads the March 2027 batch like any destination outside the EU; nothing else moves.
    assert.equal(geoAvailabilityRegion('US', true), 'intl');
    assert.equal(geoAvailabilityRegion('us', true), 'intl');
    assert.equal(geoAvailabilityRegion('BE', true), 'eu');
    assert.equal(geoAvailabilityRegion('GB', true), 'import');
    assert.equal(geoAvailabilityRegion(null, true), 'fallback');
    for (const c of ['IS', 'CA', 'AU', 'JP']) assert.equal(geoAvailabilityRegion(c), 'intl', c);
  });

  it('falls back with no header or an unknown country', () => {
    assert.equal(geoAvailabilityRegion(visitorCountry(req())), 'fallback');
    assert.equal(geoAvailabilityRegion(visitorCountry(req('XX'))), 'fallback');
    assert.equal(geoAvailabilityRegion(visitorCountry(req('T1'))), 'fallback');
    assert.equal(geoAvailabilityRegion(visitorCountry(req('be'))), 'eu');
    assert.equal(geoAvailabilityRegion(visitorCountry(req('US'))), 'us');
  });
});

describe('geoShipText', () => {
  it('serves the approved English lines', () => {
    assert.equal(geoShipText('eu', 'en'), 'In stock in Belgium, ships in a few days.');
    assert.equal(geoShipText('intl', 'en'), 'Pre-order, ships March 2027.');
  });

  it('keeps the batch 1 promise of main when the country is unknown', () => {
    for (const locale of ['en', 'nl', 'fr'] as const) assert.equal(geoShipText('fallback', locale), null);
  });

  it('has a non-empty line for every locale and region', () => {
    for (const [locale, lines] of Object.entries(GEO_AVAILABILITY_COPY)) {
      for (const region of ['eu', 'intl'] as const) assert.ok(lines[region]?.trim(), `${locale}.${region}`);
    }
  });
});

describe('structured data matches the line', () => {
  it('pairs each region with its offer fields', () => {
    assert.deepEqual(geoOfferAvailability('eu'), {availability: 'https://schema.org/InStock'});
    assert.deepEqual(geoOfferAvailability('intl'), {availability: 'https://schema.org/PreOrder', availabilityStarts: '2027-03-01'});
    assert.equal(geoOfferAvailability('fallback'), null);
  });

  it('starts the intl offer in the month the March batch ships', () => {
    assert.match(PREORDERS.pendingShips, /March 2027/);
    assert.match(INTL_AVAILABILITY_STARTS, /^2027-03-/);
  });
});

describe('batchOnePromises', () => {
  it('reads the paid batch promise from content/preorders.json (#784)', () => {
    assert.deepEqual([...batchOnePromises(PREORDERS)], ['ships late November 2026']);
  });
  it('ignores batches that are not paid stock', () => {
    assert.equal(batchOnePromises({skus: {X: {batches: [{ships: 'ships soon'}]}}}).size, 0);
  });
});

describe('offerAvailability', () => {
  const eu = geoOfferAvailability('eu');
  it('keeps a sold-out offer OutOfStock', () => {
    assert.deepEqual(offerAvailability({availableForSale: false, preorder: true, batchOne: true}, eu), {availability: 'https://schema.org/OutOfStock'});
  });
  it('gives a batch 1 offer the visitor region', () => {
    assert.deepEqual(offerAvailability({availableForSale: true, preorder: true, batchOne: true}, eu), eu);
  });
  it('keeps PreOrder for a batch 1 offer when the country is unknown', () => {
    assert.deepEqual(offerAvailability({availableForSale: true, preorder: true, batchOne: true}, null), {availability: 'https://schema.org/PreOrder'});
  });
  it('leaves other offers as they were', () => {
    assert.deepEqual(offerAvailability({availableForSale: true, preorder: true, batchOne: false}, eu), {availability: 'https://schema.org/PreOrder'});
    assert.deepEqual(offerAvailability({availableForSale: true, preorder: false, batchOne: false}, eu), {availability: 'https://schema.org/InStock'});
  });
});

describe('hasBatchOne', () => {
  it('is true only while the next unit is paid batch 1 stock', () => {
    assert.equal(hasBatchOne({paidStock: true}), true);
    // Batch 1 sold out, or a region it does not ship to: the next unit is a later batch.
    assert.equal(hasBatchOne({paidStock: false}), false);
    assert.equal(hasBatchOne(null), false);
  });
});

describe('geoBannerLines', () => {
  it('shows only the visitor line when the country is known', () => {
    assert.deepEqual(geoBannerLines('eu', 'en'), [{region: 'eu', label: 'EU', text: 'In stock in Belgium, ships in a few days.'}]);
    assert.deepEqual(geoBannerLines('intl', 'en'), [{region: 'intl', label: 'Elsewhere', text: 'Pre-order, ships March 2027.'}]);
    assert.deepEqual(geoBannerLines('import', 'en'), [{region: 'import', label: 'UK, CH, NO', text: 'Pre-order, ships March 2027. Import VAT and duties: paid by you on delivery, unless collected at checkout.'}]);
    assert.deepEqual(geoBannerLines('us', 'en'), [{region: 'us', label: 'US', text: 'Not shipping to the US yet.'}]);
  });

  it('shows both lines, labelled, when the country is unknown', () => {
    assert.deepEqual(
      geoBannerLines('fallback', 'en').map((l) => `${l.label}: ${l.text}`),
      ['EU: In stock in Belgium, ships in a few days.', 'Elsewhere: Pre-order, ships March 2027.'],
    );
  });

  it('has a heading, labels and a dismiss label in every locale', () => {
    for (const [locale, words] of Object.entries(GEO_BANNER_COPY)) {
      for (const key of ['title', 'eu', 'import', 'intl', 'us', 'dismiss'] as const) assert.ok(words[key].trim(), `${locale}.${key}`);
      assert.equal(geoBannerLines('fallback', locale as 'en' | 'nl' | 'fr').length, 2);
    }
  });
});

describe('availability card route exclusion', () => {
  it('is never rendered on /flash or any /guides page, with or without a locale prefix', () => {
    for (const p of [
      '/flash',
      '/flash/',
      '/flash?x=1',
      '/flash#step-2',
      '/guides',
      '/guides/',
      '/guides/flash-openfc/boot-mode',
      '/guides/flash-openesc/recovery?ref=x',
      '/nl/flash',
      '/fr/guides/flash-openfc/flash',
      '/en/guides',
      '/FLASH',
    ]) {
      assert.equal(availabilityBannerHiddenOn(p), true, p);
    }
  });
  it('still shows everywhere else, including look-alike paths', () => {
    for (const p of [
      '/',
      '/products/openesc',
      '/products/flash-card',
      '/support',
      '/nl',
      '/flashing',
      '/guides-old',
      '/blogs/news/flash-guide',
      '/de/flash',
      '/learn/guides',
    ]) {
      assert.equal(availabilityBannerHiddenOn(p), false, p);
    }
  });
});

describe('geoInStock (the buy button says "Add to cart", not "Pre-order")', () => {
  const batchOne = batchOnePromises(PREORDERS);
  const promise = [...batchOne][0];
  it('is true only for batch 1 stock in the EU region', () => {
    assert.ok(promise, 'preorders.json has a batch 1 promise');
    assert.equal(geoInStock('eu', {paidStock: true, shipPromise: promise}, batchOne), true);
    assert.equal(geoInStock('intl', {paidStock: true, shipPromise: promise}, batchOne), false);
    assert.equal(geoInStock('fallback', {paidStock: true, shipPromise: promise}, batchOne), false);
    assert.equal(geoInStock(null, {paidStock: true, shipPromise: promise}, batchOne), false);
  });
  it('stays a pre-order for a funding-target unit or another promise', () => {
    assert.equal(geoInStock('eu', {paidStock: false, shipPromise: promise}, batchOne), false);
    assert.equal(geoInStock('eu', {paidStock: true, shipPromise: PREORDERS.pendingShips}, batchOne), false);
    assert.equal(geoInStock('eu', null, batchOne), false);
  });
});

describe('every buy CTA asks the geo hook before saying "Pre-order"', () => {
  const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  for (const file of ['../components/ProductForm.tsx', '../components/ProductItem.tsx', '../components/RelatedProducts.tsx']) {
    it(file, () => {
      const src = read(file);
      assert.match(src, /useGeoInStock\(/);
      assert.match(src, /[sS]tatus === 'preorder' && !\w+/);
    });
  }
  it('the PDP drops the pre-order terms link for EU stock', () => {
    assert.match(read('../routes/products.$handle.tsx'), /preorder && !isBundle && !notDirect && !geoInStock/);
  });
  it('the root loader takes the ship line country from geoCountryForRequest', () => {
    assert.match(read('../root.tsx'), /geoAvailabilityRegion\(country, usRate != null\)/);
    assert.match(read('../root.tsx'), /geoCountryForRequest\(args\.request\)/);
  });
});

describe('import and US regions', () => {
  it('UK, CH and NO read the March 2027 line plus the duties note (batch 1 is EU only); nowhere else has the note', () => {
    for (const locale of ['en', 'nl', 'fr'] as const) {
      assert.equal(geoShipText('import', locale), geoShipText('intl', locale));
      assert.ok(geoDutiesNote('import', locale));
      for (const r of ['eu', 'intl', 'us', 'fallback'] as const) assert.equal(geoDutiesNote(r, locale), null);
    }
    assert.equal(geoDutiesNote('import', 'en'), 'Import VAT and duties: paid by you on delivery, unless collected at checkout.');
  });
  it('the US line makes no ship promise', () => {
    for (const locale of ['en', 'nl', 'fr'] as const) assert.doesNotMatch(geoShipText('us', locale) ?? '', /20\d\d|ships? (in|by)/i);
  });
  it('the EU is the only stock region', () => {
    assert.deepEqual((['eu', 'import', 'intl', 'us', 'fallback'] as const).filter(stockRegion), ['eu']);
    assert.deepEqual(geoOfferAvailability('import'), geoOfferAvailability('intl'));
    assert.equal(geoOfferAvailability('us'), null);
  });
  it('the phone bar has a short line for every region and locale', () => {
    for (const locale of ['en', 'nl', 'fr'] as const) for (const r of ['eu', 'import', 'intl', 'us'] as const) assert.ok(geoBarText(r, locale, true).length <= 42, `${locale}.${r}`);
  });
});

describe('structured data while US sales are on hold', () => {
  it('marks every offer ineligible for the US, and nothing when US sales are open', () => {
    assert.deepEqual(offerRegionRestriction(false), {ineligibleRegion: [{'@type': 'Country', name: 'US'}]});
    assert.deepEqual(offerRegionRestriction(true), {});
  });
  it('the PDP spreads it into the offer every variant offer copies', () => {
    const src = fs.readFileSync(new URL('../routes/products.$handle.tsx', import.meta.url), 'utf8');
    assert.match(src, /Object\.assign\(offerBase, offerRegionRestriction\(rootData\?\.usShippingRate != null\)\)/);
    assert.ok(src.indexOf('offerRegionRestriction(rootData') < src.indexOf("'@type': 'AggregateOffer'"));
  });
});
