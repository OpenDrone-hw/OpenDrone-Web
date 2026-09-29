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
