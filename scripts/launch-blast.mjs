#!/usr/bin/env node
// Launch blast: email everyone who asked to be notified about a product.
//
// Usage:
//   node scripts/launch-blast.mjs <product-handle|all>            dry run (default)
//   node scripts/launch-blast.mjs <product-handle|all> --create   sync audience + create DRAFT broadcast
//   node scripts/launch-blast.mjs <product-handle|all> --send     sync + create + SEND immediately
//   --region all|eu|us   which launch copy (default all: EU batch 1, the preorder run and the US terms)
//   node scripts/launch-blast.mjs --shopify-email-md   rewrite scripts/emails/shopify-email-launch.md
//
// The launch copy is "Preorders are open" (launchCopy below). The Shopify
// Email draft to the notify-* customers is the planned channel; this script
// is the Resend alternative and never sends without --send.
//
// Audience: the Resend segment `notify-<handle>`. The general "Newsletter"
// signup (app/routes/newsletter._index.tsx) records consent in Shopify and no
// longer writes these per-product segments, so this blasts whatever interest
// was collected before that change; it does not grow for a product launched
// after it.
//
// The broadcast itself targets the Resend segment (Broadcasts can only
// target a segment_id). Resend adds List-Unsubscribe/RFC-8058 headers and
// suppresses unsubscribed contacts automatically; the template also embeds
// the {{{RESEND_UNSUBSCRIBE_URL}}} footer link.
//
// Dry run prints recipient counts and writes the rendered
// email to scripts/out/launch-blast-<handle>-<region>.html, no API writes at all.
// --create leaves the broadcast as a DRAFT to review (and send) in the
// Resend dashboard; --send is the only path that actually emails people.
//
// Env (repo .env):
//   RESEND_API_KEY          required (needs Contacts/Segments/Broadcasts)
//   RESEND_MARKETING_FROM   optional, default hello@opendrone.be

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {COMPANY_LINE_TEXT, FACTS, button, card, escapeHtml, head, label, para, shell, text as textBlock} from '../app/lib/email-shell.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_ORIGIN = 'https://opendrone.be';
const RESEND_API = 'https://api.resend.com';

// --- env (no dotenv dep in this repo) --------------------------------------

function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  // Tolerate a missing .env: everything can come from process.env; main()
  // errors on the specific missing variables instead.
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

const env = {...loadEnv(), ...process.env};

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const regionAt = args.indexOf('--region');
  const region = regionAt >= 0 ? args[regionAt + 1] : 'all';
  if (!REGIONS.includes(region)) {
    console.error(`--region must be one of ${REGIONS.join(', ')}`);
    process.exit(1);
  }
  const rest = regionAt >= 0 ? args.filter((_, i) => i !== regionAt && i !== regionAt + 1) : args;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const positional = rest.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    console.error(
      'Usage: node scripts/launch-blast.mjs <product-handle|all> [--region all|eu|us] [--create] [--send]\n       node scripts/launch-blast.mjs --shopify-email-md',
    );
    process.exit(1);
  }
  const handle = positional[0];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(handle)) {
    console.error(`invalid product handle: ${handle}`);
    process.exit(1);
  }
  const send = flags.has('--send');
  return {handle, region, send, create: send || flags.has('--create')};
}

// --- Resend client -------------------------------------------------------------

async function resend(method, apiPath, body) {
  const res = await fetch(`${RESEND_API}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // empty body
  }
  if (!res.ok) {
    const msg = json?.message ?? '';
    return {ok: false, status: res.status, json, error: `${res.status} ${msg}`};
  }
  return {ok: true, status: res.status, json};
}

async function findSegment(name) {
  let after = null;
  for (let i = 0; i < 20; i++) {
    const q = after ? `?limit=100&after=${encodeURIComponent(after)}` : '?limit=100';
    const r = await resend('GET', `/segments${q}`);
    if (!r.ok) throw new Error(`list segments failed: ${r.error}`);
    const items = r.json?.data ?? [];
    const hit = items.find((s) => s.name === name);
    if (hit) return hit;
    if (!r.json?.has_more || items.length === 0) return null;
    after = items[items.length - 1]?.id ?? null;
    if (!after) return null;
  }
  return null;
}

async function listSegmentContacts(segmentId) {
  const contacts = [];
  let after = null;
  for (let i = 0; i < 200; i++) {
    const q = after ? `?limit=100&after=${encodeURIComponent(after)}` : '?limit=100';
    const r = await resend('GET', `/segments/${segmentId}/contacts${q}`);
    if (!r.ok) throw new Error(`list segment contacts failed: ${r.error}`);
    const items = r.json?.data ?? [];
    contacts.push(...items);
    if (!r.json?.has_more || items.length === 0) break;
    after = items[items.length - 1]?.id ?? null;
    if (!after) break;
  }
  return contacts;
}


// --- email copy and templates -----------------------------------------------------
//
// One copy definition feeds three renderings: the Resend HTML and text mail
// (renderBlast), the gallery cards, and the Shopify Email draft text
// (renderShopifyEmailMd, written to scripts/emails/shopify-email-launch.md).
// Dates come from FACTS in app/lib/email-shell.ts.

const HERO = `${SITE_ORIGIN}/og-image.png`;

const PRODUCT_TITLES = {
  openrx: 'OpenRX',
  openesc: 'OpenESC',
  'openfc-lite': 'OpenFC Lite',
  'openfc-lite-mini': 'OpenFC Lite Mini',
  openframe: 'OpenFrame',
};

function productTitle(handle) {
  return PRODUCT_TITLES[handle] ?? handle
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const REGIONS = ['all', 'eu', 'us'];

/** The launch copy for a region: `eu`, `us`, or `all` (both, for a list of unknown region). */
export function launchCopy(region = 'all') {
  if (!REGIONS.includes(region)) throw new Error(`region must be one of ${REGIONS.join(', ')}`);
  const eu = [
    {
      kicker: 'First batch, EU only',
      title: `OpenFC Lite and OpenESC ship ${FACTS.batch1}`,
      body: `The first production batch of the flight controllers and ESCs ships from Belgium in ${FACTS.batch1} 2026, to EU addresses.`,
    },
    {
      kicker: `Preorder run, closes ${FACTS.close}`,
      title: 'Receiver, frame, motors, and more FCs and ESCs',
      body: `Every unit is tested and inspected before it ships and goes straight to you from our fulfilment partner. Ships by ${FACTS.shipBy} if the target is reached by ${FACTS.close}, with delivery by ${FACTS.deliveryEu} in the EU.`,
    },
  ];
  const us = [
    {
      kicker: 'United States',
      title: 'Open for every product',
      body: `Duties are included in the price, so there is nothing to pay on delivery. US orders ship with the preorder run. Ships by ${FACTS.shipBy} if the target is reached by ${FACTS.close}, with delivery by ${FACTS.deliveryUs}. The first FC and ESC batch is for the EU only.`,
    },
    {
      kicker: 'Receiver, US sale',
      title: 'Sold conditionally in the US',
      body: 'The receiver is sold on the condition that it will not be delivered in the US until its FCC equipment authorization is granted (47 CFR 2.803). If authorization is not granted, you get a full refund for it.',
    },
  ];
  const usRun = {...eu[1], body: 'Every unit is tested and inspected before it ships and goes straight to you from our fulfilment partner.'};
  const sections = region === 'eu' ? eu : region === 'us' ? [us[0], usRun, us[1]] : [...eu, ...us];
  return {
    subject: 'Preorders are open',
    preheader: region === 'us'
      ? `OpenDrone preorders are open in the US. Duties included. The run closes ${FACTS.close}.`
      : `FC and ESC batch 1 ships ${FACTS.batch1} in the EU. The preorder run closes ${FACTS.close}.`,
    headline: 'Preorders are open.',
    intro: 'You asked to hear from us when OpenDrone launches. It is live at opendrone.be.',
    sections,
    refund: 'You pay in full at checkout. If a preorder target is not reached, we email you and you choose: a full refund for that item, or keep your order for the new date.',
    cta: 'See the hardware',
  };
}

function blastUrl(handle) {
  const campaign = `launch-${handle}`;
  const utm = `utm_source=newsletter&utm_medium=email&utm_campaign=${campaign}`;
  return handle === 'all' ? `${SITE_ORIGIN}/products?${utm}` : `${SITE_ORIGIN}/products/${handle}?${utm}`;
}

const PLAIN_FOOTER = [
  'You get this because you signed up for launch updates at opendrone.be.',
  'Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}',
  '',
  COMPANY_LINE_TEXT,
];

/** The Resend mail. `handle` is a product handle, or `all` for the whole store. */
export function renderBlast(handle = 'all', region = 'all') {
  const copy = launchCopy(region);
  const url = blastUrl(handle);
  const text = [
    copy.headline,
    '',
    copy.intro,
    '',
    ...copy.sections.flatMap((sec) => [`${sec.kicker.toUpperCase()}`, sec.title, sec.body, '']),
    copy.refund,
    ...(handle === 'all' ? [] : ['', `You asked about ${productTitle(handle)}.`]),
    '',
    `${copy.cta}: ${url}`,
    '',
    'OpenDrone',
    '',
    ...PLAIN_FOOTER,
  ].join('\n');
  const body =
    `            <tr><td style="padding: 0;"><img src="${HERO}" alt="OpenDrone flight controller, ESC and receiver boards" width="600" style="display: block; width: 100%; max-width: 600px; height: auto; border: 0;" /></td></tr>\n` +
    head('OpenDrone launch', escapeHtml(copy.headline)) +
    para(escapeHtml(copy.intro), {last: true}) +
    copy.sections
      .map((sec) =>
        card(label(escapeHtml(sec.kicker), 'accent') + `<p style="margin: 0 0 8px 0; font-family: 'Space Grotesk', Helvetica, Arial, sans-serif; font-size: 18px; font-weight: 700; color: #e5e5e5;">${escapeHtml(sec.title)}</p>` + textBlock(escapeHtml(sec.body), {last: true}), {accent: sec.kicker.startsWith('First batch')}),
      )
      .join('') +
    para(escapeHtml(copy.refund), {small: true, last: true}) +
    (handle === 'all' ? '' : para(`You asked about <strong style="color: #e5e5e5;">${escapeHtml(productTitle(handle))}</strong>.`, {small: true, last: true})) +
    button(url, `${escapeHtml(copy.cta)} &rarr;`);
  const html = shell({
    title: escapeHtml(copy.subject),
    badge: 'Launch',
    preheader: escapeHtml(copy.preheader),
    body,
    footerNote: 'You get this because you signed up for launch updates at opendrone.be. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color: #ffb700;">Unsubscribe</a>.',
  });
  return {subject: copy.subject, text, html};
}

/**
 * The Shopify Email version: plain sections, image URLs and one button, to be
 * pasted into a Shopify Email draft (Marketing, Create campaign, Shopify Email).
 * Shopify Email has its own footer, unsubscribe link and sender address.
 */
export function renderShopifyEmailMd() {
  const url = blastUrl('all').replace('utm_source=newsletter', 'utm_source=shopify-email');
  const variant = (region, label) => {
    const copy = launchCopy(region);
    return [
      `## ${label}`,
      '',
      `Subject line: ${copy.subject}`,
      `Preview text: ${copy.preheader}`,
      '',
      `Hero image: ${HERO} (alt text: OpenDrone flight controller, ESC and receiver boards)`,
      '',
      `# ${copy.headline}`,
      '',
      copy.intro,
      '',
      ...copy.sections.flatMap((sec) => [`### ${sec.kicker}`, `**${sec.title}**`, '', sec.body, '']),
      copy.refund,
      '',
      `Button: ${copy.cta} -> ${url}`,
      '',
    ];
  };
  return [
    '# Shopify Email draft: Preorders are open',
    '',
    'Generated by `node scripts/launch-blast.mjs --shopify-email-md` from the copy in `scripts/launch-blast.mjs`. Do not edit by hand.',
    '',
    'Create it as a DRAFT in Shopify admin, Marketing, Create campaign, Shopify Email. Do not send. Audience: customers tagged `notify-*` first. Sender: the store address. Paste the sections below into text blocks, add the hero as an image block, and add a button block. Shopify Email adds the footer and unsubscribe link itself.',
    '',
    ...variant('all', 'Version for a list of unknown region (default)'),
    ...variant('eu', 'EU-only version'),
    ...variant('us', 'US-only version'),
  ].join('\n');
}

// --- main ------------------------------------------------------------------------

async function main() {
  if (process.argv.includes('--shopify-email-md')) {
    const out = path.join(ROOT, 'scripts/emails/shopify-email-launch.md');
    fs.writeFileSync(out, `${renderShopifyEmailMd()}\n`);
    console.log(`wrote ${path.relative(ROOT, out)}`);
    return;
  }
  const {handle, region, create, send} = parseArgs(process.argv);
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing in .env');

  const segmentName = `notify-${handle}`;
  const mode = send ? 'SEND' : create ? 'CREATE DRAFT' : 'DRY RUN';
  console.log(`\n[launch-blast] ${handle}  (segment: ${segmentName}, region copy: ${region}, mode: ${mode})`);

  // 1. Resend segment membership.
  const segment = await findSegment(segmentName);
  let members = [];
  if (segment) {
    members = await listSegmentContacts(segment.id);
  }
  const memberEmails = new Set(
    members.map((c) => (c.email ?? '').toLowerCase()).filter(Boolean),
  );
  const unsubscribed = members.filter((c) => c.unsubscribed === true).length;
  console.log(
    `  Resend segment:  ${segment ? `${memberEmails.size} contacts (${unsubscribed} unsubscribed, auto-suppressed)` : 'does not exist yet'}`,
  );

  const {subject, text, html} = renderBlast(handle, region);

  if (!create) {
    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, {recursive: true});
    const outPath = path.join(outDir, `launch-blast-${handle}-${region}.html`);
    fs.writeFileSync(outPath, html);
    const total = memberEmails.size - unsubscribed;
    console.log(`\n  Subject:    ${subject}`);
    console.log(`  Recipients: ~${total} (segment minus unsubscribed)`);
    console.log(`  Preview:    ${path.relative(ROOT, outPath)}`);
    console.log('\n✓ Dry run: nothing written to Resend. Re-run with --create (draft) or --send.\n');
    return;
  }

  // 2. Ensure the segment exists.
  let segmentId = segment?.id;
  if (!segmentId) {
    const created = await resend('POST', '/segments', {name: segmentName});
    if (!created.ok) throw new Error(`create segment failed: ${created.error}`);
    segmentId = created.json.id;
    console.log(`  created segment ${segmentId}`);
  }

  // 3. Create the broadcast (draft unless --send).
  const broadcast = await resend('POST', '/broadcasts', {
    name: `launch-${handle}-${region}`,
    segment_id: segmentId,
    from: `OpenDrone <${env.RESEND_MARKETING_FROM || 'hello@opendrone.be'}>`,
    subject,
    html,
    text,
    ...(send ? {send: true} : {}),
  });
  if (!broadcast.ok) throw new Error(`create broadcast failed: ${broadcast.error}`);

  console.log(`\n✓ Broadcast ${send ? 'SENT' : 'created as DRAFT'}: ${broadcast.json.id}`);
  if (!send) {
    console.log('  Review + send: https://resend.com/broadcasts');
  }
  console.log('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`\n[launch-blast] failed: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
