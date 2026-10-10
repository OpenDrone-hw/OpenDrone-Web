#!/usr/bin/env node
/**
 * Vendor the Incutec identity for the /testing workspace.
 *
 * Runs the design repository's own `tools/sync-assets.sh`, which copies the
 * tokens, top bar, font faces, Poppins (OFL) and the wordmarks into this repo,
 * then scopes every vendored selector under `.testing-workspace`, so the
 * Incutec tokens cannot reach an OpenDrone page. Never edit the design
 * repository or the files this writes; re-run after a brand change.
 *
 *   node scripts/sync-testing-brand.mjs --design <path to design repo>
 *   (or INCUTEC_DESIGN=<path>)
 *
 * Writes: app/brand/testing/{tokens,topbar,fonts}.css, public/brand/*.svg,
 * public/fonts/poppins-*.woff2, public/fonts/OFL-Poppins.txt
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCOPE = '.testing-workspace';

export function scopeSelector(sel) {
  const s = sel.trim();
  if (!s || /^(from|to|\d+(\.\d+)?%)$/.test(s)) return s;
  if (s.startsWith(':root')) {
    // :root, :root[data-theme="dark"], :root:not([data-theme="light"]) ...
    return SCOPE + s.slice(':root'.length);
  }
  if (s.startsWith('[data-theme')) return SCOPE + s;
  return `${SCOPE} ${s}`;
}

/** Prefix every style rule's selector list; leave @-rules and keyframe steps alone. */
export function scopeCss(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  let i = 0;
  const stack = []; // true when the open block is @keyframes or @font-face
  while (i < src.length) {
    const open = src.indexOf('{', i);
    const close = src.indexOf('}', i);
    if (open === -1 && close === -1) {
      out += src.slice(i);
      break;
    }
    if (open !== -1 && (close === -1 || open < close)) {
      const head = src.slice(i, open);
      const t = head.trim();
      if (t.startsWith('@')) {
        stack.push(/^@(keyframes|font-face)/.test(t));
        out += head + '{';
      } else if (stack.includes(true)) {
        stack.push(true);
        out += head + '{';
      } else {
        stack.push(false);
        out += head.replace(t, t.split(',').map(scopeSelector).join(', ')) + '{';
      }
      i = open + 1;
    } else {
      out += src.slice(i, close + 1);
      stack.pop();
      i = close + 1;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--design');
  const design = at >= 0 ? args[at + 1] : process.env.INCUTEC_DESIGN;
  if (!design || !fs.existsSync(path.join(design, 'tools/sync-assets.sh'))) {
    console.error('sync-testing-brand: pass --design <design repo> or set INCUTEC_DESIGN');
    process.exit(2);
  }
  const brandCss = path.join(ROOT, 'app/brand/testing');
  execFileSync(
    'bash',
    [path.join(design, 'tools/sync-assets.sh'), '--public', path.join(ROOT, 'public'), '--brand-css', brandCss],
    {stdio: 'inherit', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}},
  );
  for (const name of ['tokens.css', 'topbar.css']) {
    const file = path.join(brandCss, name);
    const scoped = scopeCss(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(
      file,
      `/* Vendored from the Incutec design repository by scripts/sync-testing-brand.mjs.\n * Every selector is scoped under ${SCOPE}. Do not edit by hand. */\n${scoped}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
