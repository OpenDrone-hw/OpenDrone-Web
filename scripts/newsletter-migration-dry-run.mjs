#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const exportDir = process.argv[2] ? resolve(process.argv[2]) : null;
const shopifyPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!exportDir || !shopifyPath) {
  console.error('usage: node scripts/newsletter-migration-dry-run.mjs <private-odoo-export-dir> <private-shopify-customers.json>');
  process.exit(2);
}
const signupRaw = await readFile(join(exportDir, 'incutec.newsletter.signup.json'));
const manifest = JSON.parse(await readFile(join(exportDir, 'manifest.json'), 'utf8'));
const expectedHash = manifest.models?.['incutec.newsletter.signup']?.sha256;
const actualHash = createHash('sha256').update(signupRaw).digest('hex');
const signups = JSON.parse(signupRaw.toString('utf8'));
const customers = JSON.parse(await readFile(shopifyPath, 'utf8'));
const byEmail = new Map(customers
  .filter((customer) => typeof customer.email === 'string' && customer.email.trim())
  .map((customer) => [customer.email.trim().toLowerCase(), customer]));

const summary = {
  mode: 'dry-run', writes: 0,
  sourceGeneratedAt: manifest.generated_at ?? null,
  integrity: {signupHashMatches: Boolean(expectedHash && expectedHash === actualHash)},
  explicitSignupConsents: signups.length,
  planned: {
    createSubscribed: 0,
    retainSubscribed: 0,
    retainUnsubscribed: 0,
    retainOtherExistingState: 0,
    replayExplicitOptOut: 0,
    invalidSignupRows: 0,
  },
};
const seen = new Set();
for (const signup of signups) {
  if (typeof signup.email !== 'string' || !signup.email.trim() || !signup.consent_date) {
    summary.planned.invalidSignupRows += 1; continue;
  }
  const email = signup.email.trim().toLowerCase();
  if (seen.has(email)) continue;
  seen.add(email);
  const existing = byEmail.get(email);
  const explicitOptOut = signup.state === 'unsubscribed' || Boolean(signup.unsubscribed_date);
  if (explicitOptOut) {
    summary.planned.replayExplicitOptOut += 1;
  } else if (!existing) {
    summary.planned.createSubscribed += 1;
  } else {
    const state = existing.emailMarketingConsent?.marketingState;
    if (state === 'SUBSCRIBED') summary.planned.retainSubscribed += 1;
    else if (state === 'UNSUBSCRIBED') summary.planned.retainUnsubscribed += 1;
    else summary.planned.retainOtherExistingState += 1;
  }
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.integrity.signupHashMatches || summary.planned.invalidSignupRows) process.exitCode = 1;
