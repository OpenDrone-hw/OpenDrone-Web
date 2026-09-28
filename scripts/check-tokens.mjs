#!/usr/bin/env node
/**
 * app/styles/opendrone-tokens.css is vendored from OpenDrone/brand. Its first
 * line names the brand commit and the SHA-256 of the brand file; every byte
 * after that line must hash to it. Exit 1 on a mismatch.
 *
 *   npm run tokens:check                      local hash only
 *   npm run tokens:check -- --brand <path>    also compare with the brand
 *                                             checkout's file at that commit
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const FILE = new URL('../app/styles/opendrone-tokens.css', import.meta.url);
const HEADER = /^\/\* Vendored from OpenDrone\/brand commit ([0-9a-f]{40}) tokens\/dist\/opendrone-tokens\.css, sha256 ([0-9a-f]{64})\./;

const bytes = readFileSync(FILE);
const nl = bytes.indexOf(0x0a);
const header = HEADER.exec(bytes.subarray(0, nl).toString('utf8'));
if (!header) {
  console.error('opendrone-tokens.css: first line is not the vendoring header');
  process.exit(1);
}
const [, commit, expected] = header;
const body = bytes.subarray(nl + 1);
const actual = createHash('sha256').update(body).digest('hex');
if (actual !== expected) {
  console.error(`opendrone-tokens.css: sha256 ${actual}, header says ${expected}. Re-vendor from OpenDrone/brand; do not edit.`);
  process.exit(1);
}
const brandAt = process.argv.indexOf('--brand');
if (brandAt > -1) {
  const brand = process.argv[brandAt + 1];
  const source = execFileSync('git', ['-C', brand, 'show', `${commit}:tokens/dist/opendrone-tokens.css`]);
  if (!source.equals(body)) {
    console.error(`opendrone-tokens.css differs from OpenDrone/brand ${commit}`);
    process.exit(1);
  }
}
console.log(`opendrone-tokens.css ok: brand ${commit.slice(0, 12)}, sha256 ${actual.slice(0, 12)}`);
