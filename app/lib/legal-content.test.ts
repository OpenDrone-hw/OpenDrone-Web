import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Run with:
//   node --experimental-strip-types --test app/lib/legal-content.test.ts
//
// `app/content/legal/{en,nl,fr}` is the single authoritative copy of the legal
// text (erp/docs/storefront-contract.md section 7): the ERP publishes those
// files to shop.incutec.com, nothing regenerates them. A fact that lands in one
// language and not the others therefore ships as a contradiction between the
// pages a customer can read. These tests pin the commercial facts that must
// hold in every language at once.

const LOCALES = ['en', 'nl', 'fr'] as const;
type Locale = (typeof LOCALES)[number];

const LEGAL_DIR = new URL('../content/legal/', import.meta.url);

function read(locale: Locale, slug: string): string {
  return readFileSync(new URL(`${locale}/${slug}.md`, LEGAL_DIR), 'utf8');
}

/** Section headings, so a language cannot silently lose a whole section. */
function headings(src: string): number {
  return src.split(/\r?\n/).filter((line) => line.startsWith('### ')).length;
}

/**
 * The shipping rates, as numbers, from the one pipe table on the shipping
 * page. Dutch and French write `7,70` where English writes `7.70`, so the
 * decimal comma is normalised before comparing.
 */
function rates(src: string): number[] {
  const rows = src
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));
  const out: number[] = [];
  for (const row of rows) {
    for (const match of row.matchAll(/(\d+)[.,](\d{2})/g)) {
      out.push(Number(`${match[1]}.${match[2]}`));
    }
  }
  return out;
}

/** The published per-zone rates, incl. VAT, in table order: under / from 50. */
const PUBLISHED_RATES = [
  7.7, 8.1, 10.1, 11.85, 10.55, 22.05, 8.65, 33.2, 48.0, 48.0, 12.85, 33.2,
  37.45, 37.45,
];

describe('legal content parity', () => {
  it('keeps the same shipping sections in every language', () => {
    const counts = LOCALES.map((locale) => headings(read(locale, 'shipping')));
    assert.deepEqual(counts, [counts[0], counts[0], counts[0]]);
  });

  it('publishes the same per-zone shipping rates in every language', () => {
    for (const locale of LOCALES) {
      assert.deepEqual(
        rates(read(locale, 'shipping')),
        PUBLISHED_RATES,
        `shipping rates differ in ${locale}`,
      );
    }
  });

  it('states in every language that shipping is billed at dispatch', () => {
    for (const locale of LOCALES) {
      const shipping = read(locale, 'shipping');
      assert.match(
        shipping,
        /\/preorder/,
        `the funded pre-order link is missing in ${locale}`,
      );
      assert.match(
        shipping,
        /opendrone\.be\/shipping|checkout|caisse/,
        `the checkout statement is missing in ${locale}`,
      );
    }
  });

  it('carries the shipping and funding clauses in every language', () => {
    // Belgian terms number inserted articles with `bis` / `ter`; the clause
    // numbers are identical across the three translations by design.
    const clauses = [
      '3.4.',
      '7bis.8.',
      '7ter.1.',
      '7ter.2.',
      '7ter.3.',
      '7ter.4.',
      '7ter.5.',
    ];
    for (const locale of LOCALES) {
      const terms = read(locale, 'algemene-voorwaarden');
      for (const clause of clauses) {
        assert.ok(
          terms.includes(clause),
          `clause ${clause} is missing from the ${locale} terms`,
        );
      }
    }
  });

  it('keeps the statutory 14-day withdrawal right in every language', () => {
    for (const locale of LOCALES) {
      const terms = read(locale, 'algemene-voorwaarden');
      assert.match(
        terms,
        /VI\.47/,
        `the Art. VI.47 withdrawal right is missing from the ${locale} terms`,
      );
      assert.match(
        terms,
        /\*\*14 /,
        `the 14-day cooling-off period is missing from the ${locale} terms`,
      );
    }
  });
});
