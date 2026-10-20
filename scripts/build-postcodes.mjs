// Builds public/postcodes/<CC>.json (postcode -> cities) from the GeoNames postal code dumps, licence CC BY 4.0
// (https://download.geonames.org/export/zip/). Run: node scripts/build-postcodes.mjs [BE NL DE FR LU]
// The checkout fetches one file when the visitor picks that country; no address data leaves the browser for it.
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const countries = process.argv.slice(2).length ? process.argv.slice(2) : ['BE', 'NL', 'DE', 'FR', 'LU'];
const work = mkdtempSync(join(tmpdir(), 'geonames-'));
mkdirSync('public/postcodes', {recursive: true});
for (const cc of countries) {
  execFileSync('curl', ['-sSfo', join(work, `${cc}.zip`), `https://download.geonames.org/export/zip/${cc}.zip`]);
  execFileSync('unzip', ['-oq', join(work, `${cc}.zip`), `${cc}.txt`, '-d', work]);
  const map = {};
  for (const line of readFileSync(join(work, `${cc}.txt`), 'utf8').split('\n')) {
    const [, code, place] = line.split('\t');
    if (!code || !place) continue;
    // NL is published by the 4 digits; a code in the file with letters is cut to its digits.
    const key = cc === 'NL' ? code.slice(0, 4) : code;
    const list = (map[key] ??= []);
    if (!list.includes(place)) list.push(place);
  }
  const keys = Object.keys(map).sort();
  writeFileSync(`public/postcodes/${cc}.json`, JSON.stringify(Object.fromEntries(keys.map((k) => [k, map[k]]))));
  console.log(cc, keys.length, 'postcodes');
}
