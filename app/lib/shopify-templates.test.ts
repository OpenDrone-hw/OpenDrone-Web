import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {loadFixtures, loadTemplates, renderLiquid} from '../../scripts/emails/liquid.mjs';
import {buildCatalog} from '../../scripts/emails/catalog.mjs';

// Shopify has no API for notification templates, so a broken variable or
// filter would only show once pasted and sent. Every template renders
// against every fixture with strict variables and filters.
describe('Shopify notification templates', async () => {
  const [templates, fixtures] = await Promise.all([loadTemplates(), loadFixtures()]);

  it('has phase 1 templates and fixtures', () => {
    assert.ok(templates.length >= 6);
    assert.ok(fixtures.length >= 9);
  });

  for (const tpl of templates) {
    it(`${tpl.key} renders strictly against every fixture`, () => {
      const problems: string[] = [];
      for (const fx of fixtures) {
        for (const [part, source] of [['body', tpl.html], ['subject', tpl.emailSubject]]) {
          const {errors} = renderLiquid(source, fx.context);
          for (const e of errors) problems.push(`${fx.id} ${part}: ${e}`);
        }
      }
      assert.deepEqual(problems, []);
    });

    it(`${tpl.key} out/ matches its sources (run npm run gen:shopify-templates)`, () => {
      assert.equal(tpl.outStale, false);
    });
  }

  it('reports unknown variables and filters instead of rendering blank', () => {
    const {errors} = renderLiquid(
      '{{ customer.frist_name }}{{ total_price | monee }}{% for l in line_items %}{{ l.titel }}{% endfor %}',
      fixtures[0].context,
    );
    assert.equal(errors.length, 3);
    assert.match(errors.join('\n'), /customer\.frist_name/);
    assert.match(errors.join('\n'), /monee/);
    assert.match(errors.join('\n'), /l\.titel/);
  });

  it('formats money from the fixture shop format', () => {
    const eur = fixtures.find((f) => f.id === 'eu-preorder-be')!;
    const usd = fixtures.find((f) => f.id === 'us-usd')!;
    assert.equal(renderLiquid('{{ 123456 | money }}', eur.context).output, '€1.234,56');
    assert.equal(renderLiquid('{{ 123456 | money_with_currency }}', usd.context).output, '$1,234.56 USD');
  });

  it('keeps usable contract and withdrawal documents in the confirmation itself', () => {
    const tpl = templates.find((t) => t.key === 'order-confirmation')!;
    for (const id of ['eu-preorder-be', 'us-usd']) {
      const fx = fixtures.find((f) => f.id === id)!;
      const {output, errors} = renderLiquid(tpl.html, fx.context);
      assert.deepEqual(errors, []);
      assert.match(output, /Your contract documents/);
      assert.match(output, /MODEL WITHDRAWAL FORM/);
      assert.match(output, /I\/We \((?:\*|&#42;)\) hereby give notice/);
      assert.match(output, /\((?:\*|&#42;)\) Delete as appropriate\./);
      assert.match(output, /Signature of consumer\(s\)/);
      assert.ok(output.includes('&#95;'.repeat(20)) || output.includes('_'.repeat(20)), 'model form retains writing blanks');
      assert.match(output, /Legal guarantee of conformity/);
      assert.match(output, /Article 19: Language/);
      assert.ok(Buffer.byteLength(output, 'utf8') < 102_000, `${id}: confirmation risks clipping`);
    }
  });

  it('includes EU notice information inline without adding its EU heading to US orders', () => {
    const tpl = templates.find((t) => t.key === 'order-confirmation')!;
    const eu = fixtures.find((f) => f.id === 'eu-preorder-be')!;
    const us = fixtures.find((f) => f.id === 'us-usd')!;
    const euHtml = renderLiquid(tpl.html, eu.context).output;
    const usHtml = renderLiquid(tpl.html, us.context).output;
    assert.match(euHtml, /EU legal guarantee/);
    assert.match(euHtml, /Minimum two-year legal guarantee protection for goods sold in the European Union/);
    assert.match(euHtml, /free repair or free replacement/);
    assert.doesNotMatch(usHtml, /EU legal guarantee/);
    assert.match(usHtml, /Prices include import duties/);
  });

  it('separates international import charges from sale taxes and retains the delivery promise', () => {
    const tpl = templates.find((t) => t.key === 'order-confirmation')!;
    for (const id of ['international-ca', 'international-nz-gst', 'uk-gross-receipt']) {
      const fx = fixtures.find((f) => f.id === id)!;
      const {output, errors} = renderLiquid(tpl.html, fx.context);
      assert.deepEqual(errors, []);
      assert.match(output, /Delivery by 30 April 2027/);
      assert.match(output, /You pay import duties, import VAT\/GST and carrier clearance fees/);
      assert.doesNotMatch(output, /No import duties or taxes were charged/);
      assert.doesNotMatch(output, /Delivery address review/);
      assert.ok(Buffer.byteLength(output, 'utf8') < 102_000);
    }
    const nz = fixtures.find((f) => f.id === 'international-nz-gst')!;
    assert.match(renderLiquid(tpl.html, nz.context).output, /Tax recorded at checkout/);
    const uk = fixtures.find((f) => f.id === 'uk-gross-receipt')!;
    const withPendingVat = {...uk.context, tax_price: 1937};
    const receipt = renderLiquid(tpl.html, withPendingVat).output;
    assert.doesNotMatch(receipt, /Includes VAT|Tax recorded at checkout/);
    assert.match(receipt, /Payment received/);
  });

  it('flags a changed native checkout country without replacing an agreed date', () => {
    const tpl = templates.find((t) => t.key === 'order-confirmation')!;
    const fx = fixtures.find((f) => f.id === 'international-promise-mismatch')!;
    const {output, errors} = renderLiquid(tpl.html, fx.context);
    assert.deepEqual(errors, []);
    assert.match(output, /Delivery address review/);
    assert.match(output, /this email does not extend them/);
    assert.match(output, /Ships early November 2026/);
    assert.match(output, /Delivery by 30 November 2026/);
  });
});

describe('email preview catalog', () => {
  it('renders every email and scenario without problems', async () => {
    const {cards} = await buildCatalog();
    assert.ok(cards.length > 20);
    assert.deepEqual(
      cards.filter((c) => c.errors.length).map((c) => `${c.id}: ${c.errors.join('; ')}`),
      [],
    );
  });
});
