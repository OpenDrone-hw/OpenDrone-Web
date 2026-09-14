#!/usr/bin/env node
// Smoke test for OpenDrone web — hits the most important routes against
// a running dev or preview server and asserts status, headers, and a
// few content invariants. Default base URL: http://localhost:3000.
//
//   node scripts/smoke.mjs               # local dev
//   BASE=https://opendrone.store node scripts/smoke.mjs
//
// Exits non-zero on the first failure. Designed to run in CI or before
// a deploy without spinning up a test framework.

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');

const cases = [
  {
    path: '/',
    expectStatus: 200,
    expectInBody: ['OpenDrone', 'Open Source Drone Parts'],
  },
  {path: '/healthz', expectStatus: 200, expectInBody: ['ok']},
  {path: '/robots.txt', expectStatus: 200, expectInBody: ['User-agent']},
  {path: '/sitemap.xml', expectStatus: 200, expectInBody: ['<?xml']},
  {
    path: '/.well-known/security.txt',
    expectStatus: 200,
    expectInBody: ['Contact:'],
  },
  {path: '/contact', expectStatus: 200, expectInBody: ['Contact', 'Discord']},
  {path: '/support', expectStatus: 200, expectInBody: ['Support']},
  {path: '/newsletter', expectStatus: 200, expectInBody: ['Newsletter']},
  {path: '/newsletter.rss', expectStatus: 200, expectInBody: ['<rss', 'channel']},
  // Old blog URLs permanently redirect into the consolidated /newsletter.
  {path: '/blog', expectStatus: 200, expectRedirect: '/newsletter'},
  {path: '/releases', expectStatus: 200, expectRedirect: '/newsletter'},
  {path: '/open-source', expectStatus: 200, expectInBody: ['Open']},
  {path: '/firmware-partners', expectStatus: 200, expectInBody: ['Partner']},
  {path: '/legal', expectStatus: 200, expectInBody: ['Legal']},
  // Legal redirects: unprefixed lands on /en/* and renders the doc.
  {path: '/privacy', expectStatus: 200, expectInBody: ['Privacy']},
  {path: '/terms', expectStatus: 200, expectInBody: ['Terms']},
  {path: '/cookies', expectStatus: 200, expectInBody: ['Cookie']},
  // The catalog listing and a product page, both rendered from the Odoo
  // catalog feed. The PDP must carry a buy control and the hand-off link
  // to the shop: without the link the page looks fine and sells nothing.
  {path: '/products', expectStatus: 200, expectInBody: ['Products']},
  {
    path: '/products/openrx',
    expectStatus: 200,
    expectInBodyAny: ['Pre-order', 'Add to cart'],
    expectInBody: ['/incutec/add'],
  },
  // Machine-readable surfaces carry the hand-off too.
  {
    path: '/products.json',
    expectStatus: 200,
    expectInBody: ['cart_add_url'],
  },
  {path: '/llms.txt', expectStatus: 200, expectInBody: ['/incutec/add']},
  // The cart, the old collections URLs and search all land on /products.
  {path: '/cart', expectStatus: 200, expectRedirect: '/products'},
  {path: '/collections/all', expectStatus: 200, expectRedirect: '/products'},
  {path: '/search', expectStatus: 200, expectRedirect: '/products'},
  // Accounts live in the Odoo portal; /account leaves this site.
  {path: '/account', expectStatus: 200, expectRedirect: 'shop.incutec.com'},
  // 404 path returns 404, not 500.
  {path: '/this-route-does-not-exist-xyz', expectStatus: 404},
];

function fail(label, detail) {
  console.error(`FAIL ${label}: ${detail}`);
  process.exitCode = 1;
}

async function run() {
  let ok = 0;
  let bad = 0;
  for (const tc of cases) {
    const url = `${BASE}${tc.path}`;
    let res;
    try {
      res = await fetch(url, {redirect: 'follow', headers: {'user-agent': 'opendrone-smoke/1'}});
    } catch (err) {
      bad++;
      fail(tc.path, `network: ${err.message}`);
      continue;
    }
    const body = await res.text().catch(() => '');
    if (tc.expectStatus !== undefined && res.status !== tc.expectStatus) {
      bad++;
      fail(tc.path, `status ${res.status}, expected ${tc.expectStatus}`);
      continue;
    }
    if (tc.expectRedirect && !res.url.includes(tc.expectRedirect)) {
      bad++;
      fail(tc.path, `expected redirect to ${tc.expectRedirect}, got ${res.url}`);
      continue;
    }
    if (tc.expectInBodyAny) {
      const hit = tc.expectInBodyAny.some((needle) =>
        body.toLowerCase().includes(needle.toLowerCase()),
      );
      if (!hit) {
        bad++;
        fail(tc.path, `none of ${tc.expectInBodyAny.join(' / ')} in body`);
        continue;
      }
    }
    let missed = false;
    for (const needle of tc.expectInBody || []) {
      if (!body.toLowerCase().includes(needle.toLowerCase())) {
        bad++;
        fail(tc.path, `missing "${needle}" in response body`);
        missed = true;
        break;
      }
    }
    if (missed) continue;
    ok++;
    console.log(`ok   ${tc.path}  (${res.status})`);
  }
  console.log(`\n${ok} passed, ${bad} failed`);
  if (bad > 0) process.exit(1);
}

run();
