#!/usr/bin/env node
/**
 * Text budget for the /testing workspace: at most 1200 visible words, no em
 * dashes, no blockquotes. Reads the server-rendered HTML, so it counts what a
 * reader sees before any script runs: closed <details> content, SVG text,
 * scripts and styles are not counted.
 *
 *   node scripts/check-testing-text.mjs [url]   (default http://localhost:5199/testing)
 */
const url = process.argv[2] ?? 'http://localhost:5199/testing';
const BUDGET = 1200;

const html = await (await fetch(url)).text();
const body = html.slice(html.indexOf('<body'));

let t = body
  .replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<svg[\s\S]*?<\/svg>/g, ' ');
// Drop the content of <details> that are not open (keep their <summary>).
let prev;
do {
  prev = t;
  t = t.replace(/<details(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/g, (_m, inner) => {
    const s = inner.match(/<summary[\s\S]*?<\/summary>/);
    return s ? s[0] : ' ';
  });
} while (t !== prev);

const text = t
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const words = text.split(' ').filter((w) => /[A-Za-z0-9]/.test(w)).length;

const problems = [];
if (words > BUDGET) problems.push(`${words} visible words, budget ${BUDGET}`);
if (/—/.test(html.replace(/<script[\s\S]*?<\/script>/g, ''))) problems.push('em dash in the page');
if (/<blockquote/i.test(html)) problems.push('blockquote in the page');

console.log(`visible words: ${words} / ${BUDGET}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
