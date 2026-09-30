import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {describe, it} from 'node:test';

import {FACTS, applyFacts, expandMacros, shell} from './email-shell.ts';
import {launchCopy, renderBlast, renderShopifyEmailMd} from '../../scripts/launch-blast.mjs';
import {pasteList} from '../../scripts/emails/hash.mjs';

describe('email shell', () => {
  it('expands macros and refuses unknown ones', () => {
    const html = expandMacros('<od-head kicker="K">Title</od-head><od-card accent><od-label>L</od-label><od-t>T</od-t></od-card><od-button href="{{ u }}">Go</od-button>');
    assert.match(html, /<h1[^>]*>\s*Title/);
    assert.match(html, /border: 1px solid #ffb700/);
    assert.match(html, /href="\{\{ u \}\}"/);
    assert.ok(!html.includes('<od-'));
    assert.throws(() => expandMacros('<od-nope>x</od-nope>'), /unknown macro/);
  });

  it('fills fact tokens and rejects unknown ones', () => {
    assert.equal(applyFacts('closes %%CLOSE%%'), `closes ${FACTS.close}`);
    assert.throws(() => applyFacts('%%NOPE%%'), /unknown fact token/);
  });

  it('gives every mail alt text, a preheader and a phone breakpoint', () => {
    const html = shell({title: 't', badge: 'b', preheader: 'pre', body: ''});
    assert.match(html, /alt="OpenDrone"/);
    assert.match(html, /max-width: 480px/);
    assert.match(html, />\s*pre\s*</);
  });

  it('reads campaign dates and the paid batch wording from content/preorders.json', () => {
    const p: any = JSON.parse(readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'));
    assert.equal(p.endsOn, FACTS.closeIso);
    assert.equal(p.shipsBy, '2027-03-31');
    // One promise phrase everywhere: the mails say what the site says.
    assert.equal(FACTS.shipBy, '31 March 2027');
    assert.equal(p.pendingShips, `ships by ${FACTS.shipBy} if the target is reached by ${FACTS.close}, otherwise you choose a refund or to wait`);
    assert.match(p.skus['OPENFC-LITE-2020'].batches[0].ships, new RegExp(FACTS.batch1));
    assert.equal(FACTS.shipByShort, '31 Mar 2027');
    assert.equal(FACTS.closeShort, '15 Dec 2026');
  });

  it('keeps preview ship and arrival dates on the reviewed campaign promises', () => {
    const p: any = JSON.parse(readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'));
    const allowed = new Set([
      p.skus['OPENFC-LITE-2020'].batches[0].ships,
      p.pendingShips,
      `ships with the rest of this order by ${FACTS.shipBy}`,
    ]);
    const dir = new URL('../../scripts/emails/fixtures/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      for (const m of text.matchAll(/"Preorder": "([^"]*)"/g)) assert.ok(allowed.has(m[1]), `${f}: unknown Preorder promise "${m[1]}"`);
      for (const m of text.matchAll(/"Delivery by": "([^"]*)"/g)) {
        const arrivals = Object.values(p.skus).flatMap((sku: any) => sku.batches).flatMap((batch: any) => [batch.deliveryBy, batch.deliveryByUS, batch.deliveryByINT]).filter(Boolean);
        const labels = arrivals.map((iso: string) => new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(`${iso}T00:00:00Z`)));
        assert.ok(labels.includes(m[1]), `${f}: unknown arrival deadline`);
      }
    }
  });
});

describe('launch mail', () => {
  it('says preorders are open, with batch 1 EU only and the close date', () => {
    for (const region of ['all', 'eu', 'us']) {
      const {subject, text, html} = renderBlast('all', region);
      assert.equal(subject, 'Preorders are open');
      assert.match(text, /15 December 2026/i);
      assert.match(html, /RESEND_UNSUBSCRIBE_URL/);
      assert.ok(!/warehouse|Belgian QC/i.test(text));
    }
    assert.match(renderBlast('all', 'eu').text, /EU addresses/);
    assert.ok(!/first production batch/.test(renderBlast('all', 'us').text));
    assert.match(renderBlast('all', 'us').text, /47 CFR 2\.803/);
    assert.equal(launchCopy('eu').sections.length, 2);
  });

  it('keeps the Shopify Email draft in step with the copy', () => {
    const md = readFileSync(new URL('../../scripts/emails/shopify-email-launch.md', import.meta.url), 'utf8');
    assert.equal(md, `${renderShopifyEmailMd()}\n`, 'run node scripts/launch-blast.mjs --shopify-email-md');
  });
});

describe('paste list', () => {
  it('lists every generated template with a sha256', async () => {
    const rows = await pasteList();
    assert.ok(rows.length >= 20);
    for (const r of rows) assert.match(r.sha256, /^[0-9a-f]{64}$/);
  });
});
