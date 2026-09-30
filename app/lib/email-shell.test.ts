import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

  it('keeps FACTS equal to content/preorders.json', (t) => {
    const p: any = JSON.parse(readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'));
    // Gate: content/preorders.json carries the launch dates only once PR #561 merges.
    if (p.endsOn !== FACTS.closeIso && p.endsOn === '2026-11-22') {
      t.skip('content/preorders.json still has the pre-launch dates (PR #561 not merged)');
      return;
    }
    assert.equal(p.endsOn, FACTS.closeIso, 'content/preorders.json must carry the launch close date (PR #561)');
    assert.equal(p.shipsBy, '2027-03-31');
    // One promise phrase everywhere: the mails say what the site says.
    assert.equal(FACTS.shipBy, '31 March 2027');
    assert.equal(p.pendingShips, `ships by ${FACTS.shipBy} if the target is reached by ${FACTS.close}, otherwise you choose a refund or to wait`);
    assert.match(p.skus['OPENFC-LITE-2020'].batches[0].ships, new RegExp(FACTS.batch1));
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
