import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Run with:
//   node --experimental-strip-types --test app/lib/preorder-page.test.ts
//
// The preorder explainer is the page that carries the refund guarantee and
// the one-delivery rule, and every preorder product links to it. Three ways
// it can rot silently: a `<Txt>` id that no longer exists in the copy file
// (renders nothing, so a promise disappears from the page without an error),
// the route dropping out of the footer or the sitemap, and a copy edit
// reintroducing the word "goal", which on this site already means the
// financial goals in `content/goals.json`.

const read = (p: string) =>
  readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const copySrc = read('content/copy/preorder.json');
const copy = JSON.parse(copySrc) as Record<string, string | string[]>;
const route = read('app/routes/preorder.tsx');
const bodies = Object.entries(copy)
  .filter(([k]) => !k.startsWith('$') && !k.startsWith('meta_'))
  .flatMap(([, v]) => (Array.isArray(v) ? v : [v]));

describe('preorder copy', () => {
  it('answers to /preorder', () => {
    assert.equal(copy.$route, '/preorder');
  });

  it('has every id the route renders', () => {
    // The route builds its section ids from a list, so expand that list the
    // same way rather than only matching literal `preorder.x` strings.
    const sections = [...route.matchAll(/'(s\d+)'/g)].map((m) => m[1]);
    assert.ok(sections.length >= 6, `found only ${sections.length} sections`);
    const ids = [
      'title',
      'lead',
      'cta_primary',
      'cta_secondary',
      'meta_title',
      'meta_description',
      ...sections.flatMap((s) => [`${s}_title`, `${s}_body`]),
    ];
    for (const id of ids) {
      assert.ok(copy[id], `preorder.json is missing ${id}`);
    }
  });

  it('carries no id the route does not render', () => {
    for (const key of Object.keys(copy)) {
      if (key.startsWith('$')) continue;
      const stem = key.replace(/_(title|body)$/, '');
      const rendered =
        route.includes(`preorder.${key}`) ||
        route.includes(`'${stem}'`) ||
        key.startsWith('meta_');
      assert.ok(rendered, `preorder.${key} is not rendered by the route`);
    }
  });

  it('says funding target, never goal', () => {
    // "goal" is taken: app/lib/goals.ts is the money-raising meter. Two
    // different 500-unit-versus-euro meanings on one site is a support load.
    assert.ok(!/\bgoals?\b/i.test(copySrc), 'copy uses the word "goal"');
    assert.ok(
      bodies.some((b) => /funding target/.test(b)),
      'copy never says "funding target"',
    );
  });

  it('states the three promises a buyer is owed', () => {
    const all = bodies.join(' ');
    assert.match(all, /refunded in full/, 'no refund guarantee');
    assert.match(all, /mid-October 2026/, 'no stack ship window');
    assert.match(all, /about 10 weeks/, 'no post-target ship window');
  });

  it('is written in the house style', () => {
    assert.ok(!/[—–]/.test(copySrc), 'copy contains a dash character');
    // The assortment claim the plan is explicit about.
    assert.match(bodies.join(' '), /no batteries/i);
  });
});

describe('preorder registration', () => {
  it('is in the sitemap', () => {
    assert.match(read('app/routes/[sitemap.xml].tsx'), /'\/preorder',/);
  });

  it('is in the footer, with a label', () => {
    const footer = read('app/components/Footer.tsx');
    assert.match(footer, /\{to: '\/preorder', copy: 'nav_preorder'\}/);
    const chrome = JSON.parse(read('content/copy/chrome.json')) as Record<
      string,
      string
    >;
    assert.ok(chrome.nav_preorder, 'chrome.json has no nav_preorder label');
  });
});

describe('crowdfunding page copy', () => {
  it('has a question and an answer for every FAQ pair the route lists', () => {
    // The route writes the pairs out, so a copy key with no pair (or a pair
    // with no copy) is a `<details>` that opens onto nothing.
    const pairs = [...route.matchAll(/\['(faq_q\d+)', '(faq_a\d+)'\]/g)];
    assert.ok(
      pairs.length >= 8 && pairs.length <= 10,
      `expected 8 to 10 questions, found ${pairs.length}`,
    );
    for (const [, question, answer] of pairs) {
      assert.ok(copy[question], `preorder.json is missing ${question}`);
      assert.ok(copy[answer], `preorder.json is missing ${answer}`);
    }
  });

  it('has the strip, SKU tracker, updates and questions copy', () => {
    for (const id of [
      'strip_amount_label',
      'strip_backers_label',
      'strip_products_label',
      'strip_deadline_label',
      'strip_empty',
      'tracker_title',
      'tracker_lead',
      'tracker_empty',
      'faq_title',
      'updates_title',
      'updates_lead',
      'updates_empty',
    ]) {
      assert.ok(copy[id], `preorder.json is missing ${id}`);
    }
  });

  it('states the ship window in the agreed words', () => {
    assert.match(
      bodies.join(' '),
      /about 10 weeks from the funding target being reached and the supplier order placed/,
    );
  });

  it('states the money terms a buyer agrees to', () => {
    const all = bodies.join(' ');
    // Payment, shipping, delivery and the two ways out, each of which the
    // terms (article 7bis/7ter) carries and this page has to restate.
    assert.match(all, /pay for the product in full when you order/);
    assert.match(all, /billed at dispatch/);
    assert.match(all, /published rate for your zone/);
    assert.match(all, /one delivery/i);
    assert.match(all, /refunded in full, within 14 days/);
    assert.match(all, /14 days to withdraw/);
    assert.match(all, /free cancellation at any time before dispatch/);
  });

  it('links the terms rather than restating them', () => {
    assert.match(copySrc, /\[the terms\]\(\/algemene-voorwaarden\)/);
  });
});

describe('the crowdfunding route', () => {
  it('reads the catalog and applies Shopify order progress', () => {
    assert.match(route, /context\.catalog\.get\(\)/);
    assert.match(route, /fetchShopifyCampaignProgress\(context\.env\)/);
    assert.match(route, /applyCampaignProgress\(/);
    assert.doesNotMatch(route, /context\.fundingOverlay\.get\(\)/);
  });

  it('keeps its meta on the copy file', () => {
    assert.match(route, /copyText\('preorder\.meta_title'\)/);
    assert.match(route, /copyText\('preorder\.meta_description'\)/);
  });

  it('uses native disclosure for the questions', () => {
    // A scripted accordion here would cost find-in-page and pre-hydration
    // reading on the one page that carries the refund guarantee.
    assert.match(route, /<details/);
    assert.match(route, /<summary/);
  });

  it('labels every progress bar it renders', () => {
    const bars = [...route.matchAll(/role="progressbar"/g)].length;
    const labels = [
      ...route.matchAll(/aria-label=\{`\$\{campaign\.title\}[^`]+`\}/g),
    ].length;
    assert.equal(bars, 1, 'the route should render only the SKU progress bar');
    assert.equal(labels, bars, 'a progressbar with no accessible name');
    assert.match(route, /aria-valuetext=\{unitsLabel\}/);
  });

  it('has one SKU tracker and no duplicate price tier section', () => {
    assert.match(route, /function SkuTrackerRow/);
    assert.doesNotMatch(route, /id="tiers"/);
    assert.doesNotMatch(route, /<ProductPrice/);
  });
});
