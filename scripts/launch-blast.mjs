#!/usr/bin/env node
// Launch blast — email everyone who asked to be notified about a product.
//
// Usage:
//   node scripts/launch-blast.mjs <product-handle>            dry run (default)
//   node scripts/launch-blast.mjs <product-handle> --create   sync audience + create DRAFT broadcast
//   node scripts/launch-blast.mjs <product-handle> --send     sync + create + SEND immediately
//
// Audience: the Resend segment `notify-<handle>`. The general "Newsletter"
// signup (app/routes/newsletter._index.tsx) moved to Odoo double opt-in
// (erp PLAN.md 13.11) and no longer writes these per-product segments, so
// this blasts whatever interest was collected before that change; it does
// not grow for a product launched after it.
//
// The broadcast itself targets the Resend segment (Broadcasts can only
// target a segment_id). Resend adds List-Unsubscribe/RFC-8058 headers and
// suppresses unsubscribed contacts automatically; the template also embeds
// the {{{RESEND_UNSUBSCRIBE_URL}}} footer link.
//
// Dry run prints recipient counts and writes the rendered
// email to scripts/out/launch-blast-<handle>.html — no API writes at all.
// --create leaves the broadcast as a DRAFT to review (and send) in the
// Resend dashboard; --send is the only path that actually emails people.
//
// Env (repo .env):
//   RESEND_API_KEY          required (needs Contacts/Segments/Broadcasts)
//   RESEND_MARKETING_FROM   optional, default hello@opendrone.be

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_ORIGIN = 'https://opendrone.be';
const RESEND_API = 'https://api.resend.com';

// --- env (no dotenv dep in this repo) --------------------------------------

function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  // Tolerate a missing .env — everything can come from process.env; main()
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
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    console.error(
      'Usage: node scripts/launch-blast.mjs <product-handle> [--create] [--send]',
    );
    process.exit(1);
  }
  const handle = positional[0];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(handle)) {
    console.error(`invalid product handle: ${handle}`);
    process.exit(1);
  }
  const send = flags.has('--send');
  return {handle, send, create: send || flags.has('--create')};
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


// --- email template ------------------------------------------------------------

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

function renderBlast(handle) {
  const title = productTitle(handle);
  const url = `${SITE_ORIGIN}/products/${handle}?utm_source=newsletter&utm_medium=email&utm_campaign=launch-${handle}`;
  const subject = `${title} is live`;
  const text = [
    'Hi,',
    '',
    `You asked to be notified when ${title} launches — it's on sale now:`,
    url,
    '',
    'Thanks for waiting.',
    'OpenDrone',
    '',
    'You get this because you signed up for launch updates at opendrone.be.',
    'Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}',
  ].join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;font-family:Helvetica,Arial,sans-serif;line-height:1.55">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141417;border:1px solid #1a241a;border-radius:3px">
        <tr><td style="padding:28px 28px 0">
          <p style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#ffb700;margin:0 0 6px">OpenDrone</p>
          <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;letter-spacing:-0.01em;margin:0;color:#e5e5e5">It&rsquo;s live.</h1>
        </td></tr>
        <tr><td style="padding:18px 28px 28px;color:#e5e5e5;font-size:15px">
          <p>Hi,</p>
          <p>You asked to be notified when <strong>${title}</strong> launches &mdash; it&rsquo;s on sale now.</p>
          <p style="margin:24px 0 32px">
            <a href="${url}" style="display:inline-block;background:#ffb700;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;padding:12px 18px;border-radius:2px">View product &rarr;</a>
          </p>
          <p style="color:#737373;font-size:13px;line-height:1.6">You get this because you signed up for launch updates at opendrone.be. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#ffb700">Unsubscribe</a>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return {subject, text, html};
}

// --- main ------------------------------------------------------------------------

async function main() {
  const {handle, create, send} = parseArgs(process.argv);
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY missing in .env');

  const segmentName = `notify-${handle}`;
  const mode = send ? 'SEND' : create ? 'CREATE DRAFT' : 'DRY RUN';
  console.log(`\n[launch-blast] ${handle}  (segment: ${segmentName}, mode: ${mode})`);

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
    `  Resend segment:  ${segment ? `${memberEmails.size} contacts (${unsubscribed} unsubscribed — auto-suppressed)` : 'does not exist yet'}`,
  );

  const {subject, text, html} = renderBlast(handle);

  if (!create) {
    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, {recursive: true});
    const outPath = path.join(outDir, `launch-blast-${handle}.html`);
    fs.writeFileSync(outPath, html);
    const total = memberEmails.size - unsubscribed;
    console.log(`\n  Subject:    ${subject}`);
    console.log(`  Recipients: ~${total} (segment minus unsubscribed)`);
    console.log(`  Preview:    ${path.relative(ROOT, outPath)}`);
    console.log('\n✓ Dry run — nothing written to Resend. Re-run with --create (draft) or --send.\n');
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
    name: `launch-${handle}`,
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

main().catch((err) => {
  console.error(`\n[launch-blast] failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
