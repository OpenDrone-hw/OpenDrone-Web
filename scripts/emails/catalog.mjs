// Every email the business sends, rendered once per scenario for the email
// preview (scripts/emails/preview.mjs). Shopify notifications render from
// scripts/shopify-templates/ against fixtures/*.json; the Resend mails call
// the same builders the Worker and the order scripts send with, with fake
// inputs. Nothing here sends: withdrawal-email.ts is given a fetch stub that
// records the message and answers 200.
//
// Run directly it prints the cards as JSON; the preview runs it in a fresh
// child process per change so edited TypeScript modules are reloaded.

import {pathToFileURL} from 'node:url';
import path from 'node:path';

import {loadFixtures, loadTemplates, renderLiquid} from './liquid.mjs';
import {renderWelcomeEmail} from '../../app/lib/growth/welcome-email.ts';
import {sendWithdrawalNotice} from '../../app/lib/withdrawal-email.ts';
import {replyMail} from '../../app/lib/support/notify.ts';
import {renderEmail as renderPreorderEmail, formatDate, addDays} from '../preorder-notify.mjs';
import {renderBlast} from '../launch-blast.mjs';

const SUBMITTED = '2026-09-28T09:41:00.000Z';

/** The hidden preheader div of an HTML mail, as inbox previews show it. */
function htmlPreheader(html) {
  const m = /<div[^>]*display:\s*none[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

/** Inbox preview text of a plain-text mail: its opening characters. */
function textPreheader(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 110);
}

// Tokens that mean a builder interpolated a missing value.
const SUSPECT = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/;

function suspectErrors(parts) {
  const errors = [];
  for (const [label, value] of Object.entries(parts)) {
    if (typeof value !== 'string') continue;
    const m = SUSPECT.exec(value);
    if (m) errors.push(`${label} contains "${m[0]}": a missing input was interpolated`);
  }
  return errors;
}

function resendCard({id, group, email, scenario, audience, source, locale, subject, text, html, notes = []}) {
  return {
    id,
    group,
    email,
    scenario,
    audience,
    source,
    locale,
    subject,
    preheader: html ? htmlPreheader(html) : textPreheader(text),
    preheaderDerived: !html,
    html: html ?? null,
    text: text ?? null,
    notes,
    errors: suspectErrors({subject, text, html}),
  };
}

async function shopifyCards() {
  const [templates, fixtures] = await Promise.all([loadTemplates(), loadFixtures()]);
  const known = new Set(templates.map((t) => t.key));
  const cards = [];
  for (const fx of fixtures) {
    for (const key of fx.meta.templates) {
      if (!known.has(key)) throw new Error(`${fx.file}: unknown template "${key}"`);
    }
  }
  for (const tpl of templates) {
    for (const fx of fixtures.filter((f) => f.meta.templates.includes(tpl.key))) {
      const body = renderLiquid(tpl.html, fx.context);
      const subject = renderLiquid(tpl.emailSubject, fx.context);
      cards.push({
        id: `shopify-${tpl.key}--${fx.id}`,
        group: 'Shopify notifications',
        email: tpl.shopifyName,
        scenario: fx.meta.title,
        description: fx.meta.description ?? '',
        audience: tpl.key === 'staff-new-order' ? 'internal' : 'customer',
        source: [tpl.bodyFile, 'app/lib/email-shell.ts', fx.file],
        subject: subject.output,
        preheader: tpl.preheader,
        preheaderDerived: false,
        html: body.output,
        text: null,
        notes: [],
        errors: [...subject.errors.map((e) => `subject: ${e}`), ...body.errors],
        shopify: {key: tpl.key},
      });
    }
  }
  const pasteTargets = templates.map((t) => ({
    key: t.key,
    name: t.shopifyName,
    adminUrl: t.adminUrl,
    subject: t.emailSubject,
    html: t.html,
    outStale: t.outStale,
    scenarios: cards.filter((c) => c.shopify.key === t.key).length,
  }));
  return {cards, pasteTargets};
}

function welcomeCards() {
  const unsubscribeUrl = 'https://opendrone.be/newsletter/unsubscribe?t=preview-token';
  const source = ['app/lib/growth/welcome-email.ts'];
  const base = {group: 'Worker mails (Resend)', email: 'Newsletter welcome', audience: 'customer', source, locale: 'en'};
  return [
    {scenario: 'Signup from the newsletter page', product: undefined},
    {scenario: 'Signup from a product launch list', product: 'openfc-lite'},
    {scenario: 'Launch list for a handle without a title', product: 'open-goggles'},
  ].map((s, i) => resendCard({...base, id: `welcome-${i + 1}`, scenario: s.scenario, ...renderWelcomeEmail({unsubscribeUrl, product: s.product})}));
}

async function withdrawalCards() {
  const cards = [];
  for (const locale of ['nl', 'en', 'fr']) {
    const sent = [];
    const fetcher = async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response('{}', {status: 200});
    };
    await sendWithdrawalNotice(
      {RESEND_API_KEY: 'preview-no-send', PUBLIC_COMPANY_NAME: 'OpenDrone'},
      {
        name: 'Test Pilot',
        email: 'test.pilot@example.com',
        orderNumber: '#9001',
        products: 'OpenFC Lite 20x20 (1)',
        receivedOn: '2026-10-30',
        remarks: locale === 'en' ? 'Ordered the wrong size.' : '',
        locale,
        submittedAt: SUBMITTED,
      },
      fetcher,
    );
    const [shop, receipt] = sent;
    const source = ['app/lib/withdrawal-email.ts'];
    cards.push(
      resendCard({
        id: `withdrawal-receipt-${locale}`,
        group: 'Worker mails (Resend)',
        email: 'Withdrawal receipt',
        scenario: `Consumer receipt, ${locale.toUpperCase()}${locale === 'en' ? ', with remarks' : ', no remarks'}`,
        audience: 'customer',
        source,
        locale,
        subject: receipt.subject,
        text: receipt.text,
        notes: [`From ${receipt.from}`],
      }),
    );
    if (locale === 'nl') {
      cards.push(
        resendCard({
          id: 'withdrawal-shop-notice',
          group: 'Worker mails (Resend)',
          email: 'Withdrawal notice to the shop',
          scenario: 'Shop inbox, same for every locale',
          audience: 'internal',
          source,
          locale: 'nl',
          subject: shop.subject,
          text: shop.text,
          notes: [`To ${shop.to.join(', ')}, reply-to the consumer`],
        }),
      );
    }
  }
  return cards;
}

function supportCards() {
  const mail = replyMail('OD-7Q2K', 'https://opendrone.be/support/t/preview-resume-token');
  return [
    resendCard({
      id: 'support-reply',
      group: 'Worker mails (Resend)',
      email: 'Support: new reply notice',
      scenario: 'Staff answered a ticket',
      audience: 'customer',
      source: ['app/lib/support/notify.ts'],
      locale: 'en',
      ...mail,
      notes: ['Sent only with SUPPORT_EMAIL_NOTIFY_ENABLED=1 (founder\'s go).'],
    }),
  ];
}


function preorderCards() {
  const endsOn = '2026-12-15';
  const replyBy = addDays('2026-12-16', 30);
  const newDates = {en: 'early November 2026', nl: 'begin november 2026', fr: 'début novembre 2026'};
  const missedDates = {en: 'by the end of June 2027', nl: 'tegen eind juni 2027', fr: 'd’ici fin juin 2027'};
  const cards = [];
  const add = (id, scenario, locale, mail) =>
    cards.push(
      resendCard({
        id,
        group: 'Script mails (Resend)',
        email: 'Preorder buyer update',
        scenario,
        audience: 'customer',
        source: ['scripts/preorder-notify.mjs'],
        locale,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    );
  for (const locale of ['en', 'nl', 'fr']) {
    add(
      `preorder-moved-${locale}`,
      `Ship date moved, ${locale.toUpperCase()}${locale === 'en' ? ', with reason' : ''}`,
      locale,
      renderPreorderEmail('moved', {
        order: '#9001',
        product: 'OpenFC Lite - 20x20',
        qty: 1,
        newDate: newDates[locale],
        reason: locale === 'en' ? 'The connector supplier delivered two weeks late.' : null,
        email: 'test.pilot@example.com',
        locale,
      }),
    );
  }
  for (const locale of ['en', 'nl', 'fr']) {
    add(
      `preorder-missed-${locale}`,
      `Funding target missed, ${locale.toUpperCase()}, other items in the order`,
      locale,
      renderPreorderEmail('missed', {
        order: '#9002',
        product: 'OpenRX Lite',
        qty: 1,
        newDate: missedDates[locale],
        deadline: formatDate(endsOn, locale),
        replyBy: formatDate(replyBy, locale),
        others: true,
        email: 'guest.buyer@example.com',
        locale,
      }),
    );
  }
  add(
    'preorder-missed-en-only',
    'Funding target missed, EN, only item left to ship',
    'en',
    renderPreorderEmail('missed', {
      order: '#9005',
      product: 'OpenRX Lite',
      qty: 2,
      newDate: missedDates.en,
      deadline: formatDate(endsOn, 'en'),
      replyBy: formatDate(replyBy, 'en'),
      others: false,
      email: 'test.pilot@example.com',
      locale: 'en',
    }),
  );
  return cards;
}

function launchBlastCards() {
  const unsub = 'https://unsubscribe.example/preview';
  const variants = [
    ['all', 'all', 'Preorders open, list of unknown region (EU batch 1, preorder run, US terms)'],
    ['all', 'eu', 'Preorders open, EU version'],
    ['all', 'us', 'Preorders open, US version (duties included, FCC receiver line)'],
    ['openfc-lite', 'eu', 'Preorders open, EU version with a product the reader asked about'],
  ];
  return variants.map(([handle, region, scenario]) => {
    const mail = renderBlast(handle, region);
    const fill = (s) => s.replaceAll('{{{RESEND_UNSUBSCRIBE_URL}}}', unsub);
    return resendCard({
      id: `launch-blast-${handle}-${region}`,
      group: 'Script mails (Resend)',
      email: 'Launch broadcast: preorders open',
      scenario,
      audience: 'customer',
      source: ['scripts/launch-blast.mjs', 'scripts/emails/shopify-email-launch.md'],
      locale: 'en',
      subject: mail.subject,
      text: fill(mail.text),
      html: fill(mail.html),
      notes: ['Resend fills {{{RESEND_UNSUBSCRIBE_URL}}} per contact at send; shown here with a placeholder link. The Shopify Email draft uses the same copy (shopify-email-launch.md).'],
    });
  });
}

/** Every card plus the Shopify paste targets. Rendering errors of one
 *  builder become an error card instead of failing the whole gallery. */
export async function buildCatalog() {
  const {cards: shopify, pasteTargets} = await shopifyCards();
  const cards = [...shopify];
  const builders = [
    ['Newsletter welcome', welcomeCards],
    ['Withdrawal', withdrawalCards],
    ['Support reply notice', supportCards],
    ['Preorder buyer update', preorderCards],
    ['Product launch broadcast', launchBlastCards],
  ];
  for (const [name, build] of builders) {
    try {
      cards.push(...(await build()));
    } catch (err) {
      cards.push({
        id: `error-${name.toLowerCase().replace(/\W+/g, '-')}`,
        group: 'Builder errors',
        email: name,
        scenario: 'Builder threw',
        audience: 'customer',
        source: [],
        subject: '',
        preheader: '',
        html: null,
        text: null,
        notes: [],
        errors: [`builder threw: ${err?.stack ?? err}`],
      });
    }
  }
  return {generatedAt: new Date().toISOString(), cards, pasteTargets};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildCatalog()
    .then((catalog) => process.stdout.write(JSON.stringify(catalog)))
    .catch((err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    });
}
