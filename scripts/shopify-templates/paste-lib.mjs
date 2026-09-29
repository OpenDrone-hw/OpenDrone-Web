// Pure parts of paste.mjs: mapping, hashing, planning and the dry-run table.
// No browser, no network, so app/lib/paste-plan.test.ts can cover them.

import {createHash} from 'node:crypto';

export const DEFAULT_STORE_HANDLE = 'ktjqug-jw';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function editUrl(handle, adminPath) {
  return `https://admin.shopify.com/store/${handle}/email_templates/${adminPath}/edit`;
}

/** Phase 1 mappings (the ones with a body and a subject), optionally filtered by key. */
export function selectTemplates(mappings, only) {
  const wanted = only ? new Set(only) : null;
  const all = mappings.templates.filter((t) => t.phase === 1 && t.adminPath && !t.pasteSkip);
  if (wanted) {
    const known = new Set(all.map((t) => t.key));
    const unknown = [...wanted].filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`unknown template key: ${unknown.join(', ')}`);
  }
  return all.filter((t) => !wanted || wanted.has(t.key));
}

/** Parse argv: --apply, --continue, --only a,b (or --only=a,b). Unknown flags throw. */
export function parseArgs(argv) {
  const opts = {apply: false, continueOnError: false, only: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--continue') opts.continueOnError = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = a === '--only' ? argv[++i] : a.slice(7);
      if (!v) throw new Error('--only needs a comma-separated list of keys');
      opts.only = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** Shopify stores `{{ name }}` as `{{name}}`; compare without the padding. */
export function normalizeSubject(s) {
  return s.replace(/\{\{\s*/g, '{{').replace(/\s*\}\}/g, '}}').trim();
}

/** What one template needs. live = {body, subject} read from admin (subject may be null). */
export function planRow(tpl, repoBody, live) {
  const repoHash = sha256(repoBody);
  const liveHash = live ? sha256(live.body) : null;
  const bodyMatch = liveHash === repoHash;
  const subjectMatch = live?.subject != null && normalizeSubject(live.subject) === normalizeSubject(tpl.emailSubject);
  return {
    key: tpl.key,
    liveHash,
    repoHash,
    bodyMatch,
    subjectMatch,
    action: bodyMatch && subjectMatch ? 'ok' : bodyMatch ? 'set subject' : subjectMatch ? 'set body' : 'set body+subject',
  };
}

const short = (h) => (h ? h.slice(0, 12) : '-');

export function formatTable(rows) {
  const head = ['template', 'live', 'repo', 'subject', 'action'];
  const body = rows.map((r) => [
    r.key,
    short(r.liveHash),
    short(r.repoHash),
    r.error ? 'error' : r.subjectMatch ? 'match' : 'differs',
    r.error ? `ERROR: ${r.error}` : r.action,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}
