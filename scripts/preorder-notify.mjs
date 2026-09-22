#!/usr/bin/env node
// Email the buyers of one preorder batch: the ship date moved, or the
// funding target was missed and they choose a refund or to wait.
//
//   node --experimental-strip-types scripts/preorder-notify.mjs --kind moved  --sku OPENFC-LITE-2020 --batch 1 --new-date "mid November 2026"
//   node --experimental-strip-types scripts/preorder-notify.mjs --kind missed --sku OPENRX-LITE --batch 1 --new-date "by the end of June 2027"
//   ... add --send to email them (dry run otherwise)
//
//   node --experimental-strip-types scripts/preorder-notify.mjs --record "#1001" --sku OPENRX-LITE --choice refund [--apply]
//
// Options:
//   --kind moved|missed  which email (terms 7bis.3 and 7bis.3bis)
//   --sku SKU            campaign SKU from content/preorders.json
//   --batch N            only buyers whose units are in this batch (default: every batch)
//   --new-date TEXT      the new ship date, as it reads after "ships", e.g. "mid November 2026"
//   --new-date-nl TEXT   the same date in Dutch, e.g. "half november 2026" (default: --new-date)
//   --new-date-fr TEXT   the same date in French, e.g. "mi-novembre 2026" (default: --new-date)
//   --reason TEXT        optional one-sentence reason, moved emails only
//   --send               send through Resend; without it every email is printed and nothing is sent
//   --again              also email buyers already tagged as notified for this batch
//   --record ORDER       record a buyer's answer to a missed-target email as an order tag
//   --choice refund|wait the answer for --record
//   --apply              write the --record tag; without it the tag is only shown
//
// Recipients are paid, non-cancelled, non-test orders since countFrom with a
// line of the SKU still to ship (currentQuantity above 0). Batches come from
// the order's `batch:SKU:N` tags, or from the campaign count when the Worker
// has not tagged it yet. After a send, the order gets the tag
// `notified-<kind>:SKU:N` (a second run skips it unless --again) and a
// missed email records the reply deadline. Answers are recorded as
// `preorder-refund:SKU` or `preorder-wait:SKU`; refunds themselves are made
// in Shopify admin.
//
// Env (environment or .env): SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN,
// SHOPIFY_ADMIN_API_VERSION; with --send also RESEND_API_KEY, and optionally
// SUPPORT_FROM_EMAIL (default support@opendrone.be) and PUBLIC_COMPANY_EMAIL
// (reply-to, default contact@opendrone.be). The Admin token needs read_orders
// and write_orders. Nothing secret is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEND_API = 'https://api.resend.com/emails';
const REPLY_DAYS = 30;
const SIGNATURE = ['Incutec BV (OpenDrone)', 'Stapelhuisstraat 15, 3000 Leuven, Belgium', 'contact@opendrone.be'];

// ---------------------------------------------------------------------------
// Pure parts (unit tested in app/lib/preorder-notify.test.ts)
// ---------------------------------------------------------------------------

export function parseArgs(argv, campaignSkus) {
  const opts = {kind: null, sku: null, batch: null, newDate: null, newDateNl: null, newDateFr: null, reason: null, send: false, again: false, record: null, choice: null, apply: false};
  const value = (i) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i - 1]} needs a value`);
    return v.trim();
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--send') opts.send = true;
    else if (arg === '--again') opts.again = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--kind') opts.kind = value((i += 1));
    else if (arg === '--sku') opts.sku = value((i += 1));
    else if (arg === '--new-date') opts.newDate = value((i += 1));
    else if (arg === '--new-date-nl') opts.newDateNl = value((i += 1));
    else if (arg === '--new-date-fr') opts.newDateFr = value((i += 1));
    else if (arg === '--reason') opts.reason = value((i += 1));
    else if (arg === '--record') opts.record = value((i += 1));
    else if (arg === '--choice') opts.choice = value((i += 1));
    else if (arg === '--batch') {
      const n = Number(value((i += 1)));
      if (!Number.isInteger(n) || n < 1) throw new Error('--batch needs a whole number from 1');
      opts.batch = n;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.sku || !campaignSkus.includes(opts.sku)) {
    throw new Error(`--sku needs a campaign SKU (${campaignSkus.join(', ')})`);
  }
  if (opts.record) {
    if (!['refund', 'wait'].includes(opts.choice)) throw new Error('--record needs --choice refund or --choice wait');
    if (opts.send) throw new Error('--record and --send do not go together');
    return opts;
  }
  if (!['moved', 'missed'].includes(opts.kind)) throw new Error('--kind must be moved or missed');
  if (!opts.newDate) throw new Error('--new-date is required: the new ship date the email promises');
  if (opts.reason && opts.kind !== 'moved') throw new Error('--reason is for moved emails only');
  return opts;
}

export function localeOf(customerLocale) {
  const l = String(customerLocale ?? '').toLowerCase();
  if (l.startsWith('nl')) return 'nl';
  if (l.startsWith('fr')) return 'fr';
  return 'en';
}

const INTL = {en: 'en-GB', nl: 'nl-BE', fr: 'fr-BE'};

export function formatDate(isoDay, locale) {
  const date = new Date(`${isoDay}T12:00:00Z`);
  return new Intl.DateTimeFormat(INTL[locale], {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'}).format(date);
}

export function addDays(isoDay, days) {
  const date = new Date(`${isoDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Orders to email for `sku`: counted, with a line of the SKU still to
 * ship, in `batch` when given. `batchesOf(order)` gives the order's
 * batches of the SKU (from tags, else the campaign count).
 */
export function selectRecipients(orders, {sku, batch, kind, again, isCounted, batchesOf}) {
  const out = [];
  for (const order of orders) {
    if (!isCounted(order)) continue;
    const line = order.lineItems.nodes.find((l) => l.sku?.trim() === sku && l.currentQuantity > 0);
    if (!line) continue;
    const batches = batchesOf(order);
    const matched = batch == null ? batches : batches.filter((b) => b === batch);
    if (!matched.length) continue;
    const tags = matched.map((b) => `notified-${kind}:${sku}:${b}`);
    if (!again && tags.every((t) => order.tags.includes(t))) continue;
    if (!order.email) continue;
    const others = order.lineItems.nodes.some((l) => l !== line && l.currentQuantity > 0);
    out.push({order, line, batches: matched, notifiedTags: tags, others});
  }
  return out;
}

const COPY = {
  en: {
    movedSubject: (o, p) => `Your OpenDrone order ${o}: new ship date for ${p}`,
    moved: ({order, product, qty, newDate, reason}) => [
      'Hello,',
      '',
      `The ship date of ${product} (${qty} in your order ${order}) has moved. It now ships ${newDate}.`,
      ...(reason ? [reason] : []),
      '',
      'You do not need to do anything. Your order still ships as one parcel once every item in it is ready.',
      '',
      'If the new date does not work for you, you can cancel before it ships and we refund everything you paid for it within 14 days. Reply to this email, or use the form at https://opendrone.be/herroepingsrecht.',
    ],
    missedSubject: (o, p) => `Your OpenDrone order ${o}: ${p} did not reach its funding target`,
    missed: ({order, product, qty, newDate, deadline, replyBy, others}) => [
      'Hello,',
      '',
      `${product} did not reach its funding target by ${deadline}. You ordered ${qty} in order ${order}.`,
      '',
      'Please choose one of two options by replying to this email with REFUND or WAIT:',
      '',
      `REFUND: we cancel ${product} in your order and refund everything you paid for it within 14 days.`,
      `WAIT: you keep your order and ${product} ships ${newDate}. You can still cancel it at any time before it ships, with a full refund.`,
      '',
      `If we do not hear from you by ${replyBy}, we cancel ${product} and refund everything you paid for it within 14 days after that date.`,
      ...(others
        ? ['', 'The rest of your order ships as soon as it is ready, whichever you choose. If you wait, this item ships on its own later, at no extra shipping cost.', 'If a refund leaves nothing else in your order to ship, we refund the shipping costs too.']
        : ['', 'This is the only item left to ship in your order, so a refund includes the shipping costs you paid.']),
    ],
  },
  nl: {
    movedSubject: (o, p) => `Uw OpenDrone-bestelling ${o}: nieuwe verzenddatum voor ${p}`,
    moved: ({order, product, qty, newDate, reason}) => [
      'Hallo,',
      '',
      `De verzenddatum van ${product} (${qty} in uw bestelling ${order}) is verschoven. Nieuwe verzending: ${newDate}.`,
      ...(reason ? [reason] : []),
      '',
      'U hoeft niets te doen. Uw bestelling vertrekt nog altijd als één pakket zodra alles erin klaar is.',
      '',
      'Past de nieuwe datum u niet, dan kunt u annuleren zolang het niet verzonden is. Wij betalen alles wat u ervoor betaalde binnen 14 dagen terug. Antwoord op deze e-mail of gebruik het formulier op https://opendrone.be/herroepingsrecht.',
    ],
    missedSubject: (o, p) => `Uw OpenDrone-bestelling ${o}: ${p} haalde het financieringsdoel niet`,
    missed: ({order, product, qty, newDate, deadline, replyBy, others}) => [
      'Hallo,',
      '',
      `${product} haalde het financieringsdoel niet vóór ${deadline}. U bestelde er ${qty} in bestelling ${order}.`,
      '',
      'Kies een van deze twee opties door op deze e-mail te antwoorden met TERUGBETALING of WACHTEN:',
      '',
      `TERUGBETALING: wij annuleren ${product} in uw bestelling en betalen alles wat u ervoor betaalde binnen 14 dagen terug.`,
      `WACHTEN: u behoudt uw bestelling en ${product} wordt verzonden: ${newDate}. U kunt nog altijd annuleren tot het verzonden is, met volledige terugbetaling.`,
      '',
      `Horen wij niets van u vóór ${replyBy}, dan annuleren wij ${product} en betalen wij alles wat u ervoor betaalde binnen 14 dagen na die datum terug.`,
      ...(others
        ? ['', 'De rest van uw bestelling vertrekt zodra ze klaar is, wat u ook kiest. Kiest u wachten, dan volgt dit product later apart, zonder extra verzendkosten.', 'Blijft er na een terugbetaling niets meer te verzenden, dan betalen wij ook de verzendkosten terug.']
        : ['', 'Dit is het enige product dat nog verzonden moet worden, dus een terugbetaling omvat ook de verzendkosten.']),
    ],
  },
  fr: {
    movedSubject: (o, p) => `Votre commande OpenDrone ${o} : nouvelle date d’envoi pour ${p}`,
    moved: ({order, product, qty, newDate, reason}) => [
      'Bonjour,',
      '',
      `La date d’envoi de ${product} (${qty} dans votre commande ${order}) a changé. Nouvel envoi : ${newDate}.`,
      ...(reason ? [reason] : []),
      '',
      'Vous n’avez rien à faire. Votre commande part toujours en un seul colis dès que tout est prêt.',
      '',
      'Si la nouvelle date ne vous convient pas, vous pouvez annuler tant que l’article n’est pas expédié. Nous remboursons tout ce que vous avez payé pour cet article sous 14 jours. Répondez à ce courriel ou utilisez le formulaire sur https://opendrone.be/herroepingsrecht.',
    ],
    missedSubject: (o, p) => `Votre commande OpenDrone ${o} : ${p} n’a pas atteint son objectif de financement`,
    missed: ({order, product, qty, newDate, deadline, replyBy, others}) => [
      'Bonjour,',
      '',
      `${product} n’a pas atteint son objectif de financement au ${deadline}. Vous en avez commandé ${qty} dans la commande ${order}.`,
      '',
      'Choisissez l’une de ces deux options en répondant à ce courriel par REMBOURSEMENT ou ATTENDRE :',
      '',
      `REMBOURSEMENT : nous annulons ${product} dans votre commande et remboursons tout ce que vous avez payé pour cet article sous 14 jours.`,
      `ATTENDRE : vous gardez votre commande et ${product} sera expédié : ${newDate}. Vous pouvez toujours annuler avant l’envoi, avec un remboursement complet.`,
      '',
      `Sans réponse de votre part avant le ${replyBy}, nous annulons ${product} et remboursons tout ce que vous avez payé pour cet article sous 14 jours après cette date.`,
      ...(others
        ? ['', 'Le reste de votre commande part dès qu’il est prêt, quel que soit votre choix. Si vous attendez, cet article suivra séparément, sans frais d’envoi supplémentaires.', 'Si un remboursement ne laisse plus rien à expédier dans votre commande, nous remboursons aussi les frais d’envoi.']
        : ['', 'C’est le seul article qui reste à expédier dans votre commande : un remboursement inclut donc les frais d’envoi.']),
    ],
  },
};

/**
 * One rendered email.
 * @param {'moved' | 'missed'} kind
 * @param {{order: string, product: string, qty: number, newDate: string, email: string, locale: string,
 *   reason?: string | null, deadline?: string, replyBy?: string, others?: boolean}} fields
 * @returns {{to: string, subject: string, text: string}}
 */
export function renderEmail(kind, {order, product, qty, newDate, reason, deadline, replyBy, others, email, locale}) {
  const copy = COPY[locale] ?? COPY.en;
  const body = kind === 'moved'
    ? copy.moved({order, product, qty, newDate, reason})
    : copy.missed({order, product, qty, newDate, deadline, replyBy, others});
  return {
    to: email,
    subject: kind === 'moved' ? copy.movedSubject(order, product) : copy.missedSubject(order, product),
    text: [...body, '', ...SIGNATURE].join('\n'),
  };
}

/** Show an address without printing it in full. */
export function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  return domain ? `${user.slice(0, 1)}***@${domain}` : '***';
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

async function loadLib() {
  try {
    return await import('../app/lib/preorder-fulfilment.ts');
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error('run with node --experimental-strip-types (Node 22) or Node 23.6+');
    }
    throw error;
  }
}

async function sendEmail(mail, idempotencyKey) {
  const from = process.env.SUPPORT_FROM_EMAIL || 'support@opendrone.be';
  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      from: `OpenDrone <${from}>`,
      to: [mail.to],
      reply_to: process.env.PUBLIC_COMPANY_EMAIL || 'contact@opendrone.be',
      subject: mail.subject,
      text: mail.text,
    }),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

async function main() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
  const preorders = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/preorders.json'), 'utf8'));
  const opts = parseArgs(process.argv.slice(2), Object.keys(preorders.skus ?? {}));
  const lib = await loadLib();
  const env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_API_TOKEN: process.env.SHOPIFY_ADMIN_API_TOKEN,
    SHOPIFY_ADMIN_API_VERSION: process.env.SHOPIFY_ADMIN_API_VERSION,
  };
  const orders = await lib.fetchPreorderOrders(env, preorders.countFrom);

  if (opts.record) {
    const name = opts.record.startsWith('#') ? opts.record : `#${opts.record}`;
    const order = orders.find((o) => o.name === name);
    if (!order) throw new Error(`${name}: no order since ${preorders.countFrom}`);
    const tag = `preorder-${opts.choice}:${opts.sku}`;
    if (order.tags.includes(tag)) {
      console.log(`${name} already has ${tag}`);
      return;
    }
    if (!opts.apply) {
      console.log(`DRY RUN: would tag ${name} with ${tag}. Add --apply to write it.`);
      return;
    }
    const data = await lib.adminGraphql(env, lib.TAGS_ADD_MUTATION, {id: order.id, tags: [tag]});
    if (data.tagsAdd.userErrors.length) throw new Error(`tagsAdd: ${data.tagsAdd.userErrors[0].message}`);
    console.log(`${name}: tagged ${tag}`);
    return;
  }

  if (opts.send && !process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const assigned = lib.assignBatches(orders, preorders);
  const batchesOf = (order) => {
    const tagged = order.tags.map(lib.parseBatchTag).filter((b) => b && b.sku === opts.sku).map((b) => b.batch);
    if (tagged.length) return tagged;
    return (assigned.get(order.id) ?? []).filter((b) => b.sku === opts.sku).map((b) => b.batch);
  };
  const recipients = selectRecipients(orders, {
    sku: opts.sku,
    batch: opts.batch,
    kind: opts.kind,
    again: opts.again,
    isCounted: lib.isCountedOrder,
    batchesOf,
  });

  const today = new Date().toISOString().slice(0, 10);
  const replyByDay = addDays(today, REPLY_DAYS);
  console.log(
    `${opts.send ? 'SEND' : 'DRY RUN (nothing is sent)'}: ${opts.kind} email for ${opts.sku}${opts.batch ? ` batch ${opts.batch}` : ''}, ${recipients.length} order(s).`,
  );
  let failed = 0;
  for (const r of recipients) {
    const locale = localeOf(r.order.customerLocale);
    const mail = renderEmail(opts.kind, {
      order: r.order.name,
      product: r.line.name,
      qty: r.line.currentQuantity,
      newDate: (locale === 'nl' && opts.newDateNl) || (locale === 'fr' && opts.newDateFr) || opts.newDate,
      reason: opts.reason,
      deadline: formatDate(preorders.endsOn, locale),
      replyBy: formatDate(replyByDay, locale),
      others: r.others,
      email: r.order.email,
      locale,
    });
    console.log(`\n--- ${r.order.name} to ${maskEmail(mail.to)} (${locale}) ---`);
    if (!opts.send) {
      console.log(`Subject: ${mail.subject}\n\n${mail.text}`);
      continue;
    }
    try {
      await sendEmail(mail, `${r.order.id}:${r.notifiedTags.join(',')}:${today}`);
      const tags = [...r.notifiedTags];
      if (opts.kind === 'missed') tags.push(`reply-by:${replyByDay}`);
      const data = await lib.adminGraphql(env, lib.TAGS_ADD_MUTATION, {id: r.order.id, tags});
      if (data.tagsAdd.userErrors.length) {
        failed += 1;
        console.log(`  sent, but not tagged (a rerun would email again): ${data.tagsAdd.userErrors[0].message}`);
      } else console.log('  sent and tagged');
    } catch (error) {
      failed += 1;
      console.log(`  not sent: ${error.message}`);
    }
  }
  if (!opts.send && recipients.length) console.log('\nAdd --send to email these buyers.');
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`preorder-notify: ${error.message}`);
    process.exit(1);
  });
}
