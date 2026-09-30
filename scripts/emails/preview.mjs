#!/usr/bin/env node
// Email preview: every email the business sends, one card per email and
// scenario, rendered at desktop and 375 px mobile width.
//
//   npm run emails:preview            local server with reload on save
//   npm run emails:build              one self-contained HTML file for sharing
//
// Options:
//   --port N     server port (default 4321)
//   --build      write the static gallery instead of serving it
//   --out PATH   static gallery path (default <workspace>/.review/emails/index.html)
//
// The catalog (scripts/emails/catalog.mjs) renders in a fresh child process
// on every change, so edits to bodies, fixtures and the TypeScript builders
// all show without a restart. Nothing is sent and no API is called; the
// static build only fetches the remote images the emails embed, to inline
// them.

import {spawn, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CATALOG = path.join(HERE, 'catalog.mjs');

const WATCH = [
  {dir: 'content', recursive: false, files: ['preorders.json']},
  {dir: 'scripts/shopify-templates', recursive: true},
  {dir: 'scripts/emails', recursive: true},
  {dir: 'app/lib', recursive: true},
  {dir: 'scripts', recursive: false, files: ['preorder-notify.mjs', 'launch-blast.mjs']},
];

function parseArgs(argv) {
  const opts = {port: 4321, build: false, out: null};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--build') opts.build = true;
    else if (arg === '--port' || arg === '--out') {
      const v = argv[(i += 1)];
      if (!v || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--port') {
        opts.port = Number(v);
        if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port needs a port number');
      } else opts.out = path.resolve(v);
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** The workspace root: the nearest directory above the main checkout with repos.json. */
function workspaceRoot() {
  let dir = ROOT;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: ROOT, encoding: 'utf8'}).trim();
    dir = path.dirname(common);
  } catch {
    // not a git checkout: search from the repository directory
  }
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'repos.json'))) return d;
  }
  return null;
}

/** Render the catalog in a child process: {catalog} or {error}. */
function renderCatalog() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CATALOG], {cwd: ROOT});
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => {
      if (code !== 0) return resolve({error: Buffer.concat(err).toString() || `catalog exited with ${code}`});
      try {
        resolve({catalog: JSON.parse(Buffer.concat(out).toString())});
      } catch (e) {
        resolve({error: `catalog output was not JSON: ${e.message}`});
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Links in a preview open in a new tab instead of inside the frame.
function frameDoc(card) {
  if (card.html) {
    const base = '<base target="_blank">';
    return /<head[^>]*>/i.test(card.html) ? card.html.replace(/<head([^>]*)>/i, `<head$1>${base}`) : base + card.html;
  }
  const text = esc(card.text ?? '').replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#1a56db">${u}</a>`);
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0;background:#ffffff;color:#1a1a1a;"><pre style="margin:0;padding:24px;white-space:pre-wrap;word-wrap:break-word;font:15px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">${text}</pre></body></html>`;
}

function renderCard(card) {
  const errors = card.errors.length
    ? `<div class="banner error"><strong>${card.errors.length} problem${card.errors.length > 1 ? 's' : ''}: fix before pasting or sending</strong><ul>${card.errors.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul></div>`
    : '';
  const notes = card.notes?.length ? `<ul class="notes">${card.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  const copy = card.shopify
    ? `<div class="paste"><button type="button" data-copy="${esc(card.shopify.key)}" data-part="html">Copy template HTML</button><button type="button" data-copy="${esc(card.shopify.key)}" data-part="subject">Copy subject</button><a data-admin="${esc(card.shopify.key)}" target="_blank" rel="noopener">Open in Shopify admin</a></div>`
    : '';
  const doc = esc(frameDoc(card));
  const frames = card.html || card.text
    ? `<div class="frames">
        <figure><figcaption>Desktop</figcaption><iframe class="desktop" title="${esc(card.email)} desktop" srcdoc="${doc}" loading="lazy"></iframe></figure>
        <figure><figcaption>Mobile 375 px</figcaption><iframe class="mobile" title="${esc(card.email)} mobile" srcdoc="${doc}" loading="lazy"></iframe></figure>
      </div>`
    : '';
  const textPart = card.html && card.text ? `<details><summary>Plain-text part</summary><pre class="textpart">${esc(card.text)}</pre></details>` : '';
  return `<article class="card${card.errors.length ? ' has-errors' : ''}" id="${esc(card.id)}" data-group="${esc(card.group)}" data-audience="${esc(card.audience)}" data-search="${esc(`${card.email} ${card.scenario} ${card.subject}`.toLowerCase())}">
    <header>
      <h3>${esc(card.email)} <span class="scenario">${esc(card.scenario)}</span></h3>
      <div class="tags"><span class="tag ${card.audience}">${esc(card.audience)}</span>${card.locale ? `<span class="tag">${esc(card.locale)}</span>` : ''}${card.html ? '<span class="tag">html</span>' : '<span class="tag">plain text</span>'}</div>
    </header>
    ${errors}
    ${card.description ? `<p class="desc">${esc(card.description)}</p>` : ''}
    <dl class="meta">
      <dt>Subject</dt><dd class="subject">${esc(card.subject) || '<em>none</em>'}</dd>
      <dt>Preheader</dt><dd>${esc(card.preheader) || '<em>none</em>'}${card.preheaderDerived ? ' <span class="muted">(no preheader: inbox shows the opening text)</span>' : ''}</dd>
    </dl>
    <details><summary>Agent reference</summary><p class="muted">${card.source.map((s) => `<code>${esc(s)}</code>`).join(' ')}</p></details>
    ${notes}${copy}
    ${frames}
    ${textPart}
  </article>`;
}

function renderPasteTable(targets) {
  if (!targets?.length) return '';
  const rows = targets
    .map(
      (t) => `<tr>
        <td>${esc(t.name)}${t.outStale ? ' <span class="stale">out/ is stale: run <code>npm run gen:shopify-templates</code></span>' : ''}</td>
        <td class="subject-cell"><code>${esc(t.subject)}</code></td>
        <td><a href="#${esc(`shopify-${t.key}`)}">${t.scenarios} scenario${t.scenarios === 1 ? '' : 's'}</a></td>
        <td><button type="button" data-copy="${esc(t.key)}" data-part="html">Copy HTML</button> <button type="button" data-copy="${esc(t.key)}" data-part="subject">Copy subject</button></td>
        <td><a href="${esc(t.adminUrl)}" target="_blank" rel="noopener">${esc(t.adminUrl.replace('https://admin.shopify.com/store/', ''))}</a></td>
      </tr>`,
    )
    .join('');
  return `<details class="paste-table"><summary>Shopify notification templates: copy or open in admin</summary>
    <p class="muted">Ask an agent to install reviewed changes. You can also copy the template and subject into Shopify's notification editor and save. These templates are separate from the launch campaign in Shopify Email.</p>
    <div class="table-scroll"><table><thead><tr><th>Template</th><th>Subject</th><th>Preview</th><th>Copy</th><th>Admin</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function jsonScript(id, value) {
  return `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
}

function renderPage({catalog, error, live}) {
  const cards = catalog?.cards ?? [];
  const broken = cards.filter((c) => c.errors.length);
  const groups = [...new Set(cards.map((c) => c.group))];
  const nav = groups
    .map((g) => {
      const items = cards
        .filter((c) => c.group === g)
        .map((c) => `<li><a href="#${esc(c.id)}"${c.errors.length ? ' class="bad"' : ''}>${esc(c.email)}: ${esc(c.scenario)}</a></li>`)
        .join('');
      return `<li><a href="#${slug(g)}">${esc(g)}</a><ul>${items}</ul></li>`;
    })
    .join('');
  const firstIds = new Set();
  const body = groups
    .map((g) => {
      const list = cards.filter((c) => c.group === g);
      const html = list
        .map((c) => {
          // An anchor per Shopify template, for the paste table's links.
          const anchor = c.shopify && !firstIds.has(c.shopify.key) ? (firstIds.add(c.shopify.key), `<span id="shopify-${esc(c.shopify.key)}"></span>`) : '';
          return anchor + renderCard(c);
        })
        .join('');
      return `<section id="${slug(g)}"><h2>${esc(g)} <span class="muted">${list.length}</span></h2>${html}</section>`;
    })
    .join('');
  const payload = Object.fromEntries((catalog?.pasteTargets ?? []).map((t) => [t.key, {html: t.html, subject: t.subject, adminUrl: t.adminUrl}]));
  const summary = broken.length
    ? `<div class="banner error"><strong>${broken.length} of ${cards.length} cards have problems.</strong> ${broken.map((c) => `<a href="#${esc(c.id)}">${esc(c.email)}: ${esc(c.scenario)}</a>`).join(', ')}</div>`
    : cards.length
      ? `<div class="banner ok">${cards.length} cards, no problems found.</div>`
      : '';
  const fatal = error ? `<div class="banner error"><strong>The catalog failed to render${catalog ? '; showing the last good render below' : ''}.</strong><pre>${esc(error)}</pre></div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenDrone emails</title>
<style>
:root{--bg:#141618;--panel:#1c1f22;--line:#2c3136;--text:#e6e6e6;--muted:#9aa0a6;--gold:#ffb700;--red:#ff5c5c;--redbg:#3a1414;--green:#5fd38d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
a{color:var(--gold)}
code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.layout{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow:auto;padding:20px 16px;border-right:1px solid var(--line);font-size:12px}
nav ul{list-style:none;margin:0;padding:0}
nav>ul>li{margin-bottom:14px}
nav>ul>li>a{font-weight:700;color:var(--text);text-decoration:none}
nav li li a{display:block;padding:2px 0 2px 8px;color:var(--muted);text-decoration:none}
nav li li a.bad{color:var(--red)}
main{padding:24px 16px 80px;max-width:1240px}
h1{margin:0 0 4px;font-size:22px}
h2{margin:36px 0 12px;font-size:18px}
.muted{color:var(--muted);font-weight:400}
.banner{padding:12px 16px;margin:12px 0;border:1px solid var(--line)}
.banner.error{background:var(--redbg);border-color:var(--red);color:#ffd6d6}
.banner.error ul{margin:6px 0 0;padding-left:18px}
.banner.ok{border-color:var(--green);color:var(--green)}
.banner pre{white-space:pre-wrap;margin:8px 0 0}
.card{background:var(--panel);border:1px solid var(--line);padding:16px;margin:0 0 20px}
.card.has-errors{border-color:var(--red)}
.card header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px}
.card h3{margin:0;font-size:16px}
.scenario{display:block;font-weight:400;color:var(--muted);font-size:13px}
.tags{display:flex;gap:6px;align-items:flex-start}
.tag{border:1px solid var(--line);padding:1px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.tag.internal{border-color:#6b5a2a;color:#e0c070}
.desc{margin:8px 0 0;color:var(--muted)}
.meta{display:grid;grid-template-columns:90px minmax(0,1fr);gap:4px 12px;margin:12px 0}
.meta dt{color:var(--muted)}
.meta dd{margin:0;overflow-wrap:anywhere}
.subject{font-weight:700}
.notes{margin:0 0 10px;padding-left:18px;color:var(--muted)}
.paste{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px}
button{background:var(--gold);color:#0a0a0a;border:0;padding:6px 12px;font:700 12px/1.2 ui-monospace,Menlo,monospace;cursor:pointer}
button.done{background:var(--green)}
[hidden]{display:none!important}
.filters{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0;align-items:end}
.filters label{display:flex;flex-direction:column;gap:4px;color:var(--muted)}
.filters input,.filters select{background:var(--panel);color:var(--text);border:1px solid var(--line);padding:8px;font:inherit;max-width:100%}
.filters input{width:300px}
.table-scroll{overflow-x:auto}
.review-flow{max-width:760px}
.frames{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
figure{margin:0;max-width:100%}
figcaption{font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.06em}
iframe{display:block;border:1px solid var(--line);background:#fff;height:160px;max-width:100%}
iframe.desktop{width:660px}
iframe.mobile{width:375px}
details{margin-top:12px}
summary{cursor:pointer;color:var(--muted)}
.textpart{white-space:pre-wrap;background:#0f1113;padding:12px;border:1px solid var(--line);overflow:auto}
.paste-table table{border-collapse:collapse;width:100%;font-size:13px}
.paste-table th,.paste-table td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}
.subject-cell code{overflow-wrap:anywhere}
.stale{display:block;color:var(--red);font-size:12px}
@media (max-width:900px){.layout{grid-template-columns:1fr}nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<div class="layout">
<nav><strong>OpenDrone emails</strong><ul style="margin-top:12px">${nav}</ul></nav>
<main>
<h1>OpenDrone emails</h1>
<p class="muted">${cards.length} email previews${catalog ? `, generated ${esc(catalog.generatedAt)}` : ''}${live ? '. Refreshes as your agent makes changes' : ''}. All names and addresses are examples.</p>
<p class="review-flow">Pick an email and review its desktop and phone previews. Tell your agent the email name, scenario and requested changes here or in Notion. The agent updates the previews and installs approved notification templates in Shopify. Review and send the launch campaign in Shopify Email.</p>
${fatal}${summary}
<div class="filters">
<label>Find an email<input id="email-search" type="search" placeholder="Order, refund, US receiver…"></label>
<label>Channel<select id="email-group"><option value="">All channels</option>${groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select></label>
<label>Audience<select id="email-audience"><option value="">Everyone</option><option value="customer">Customer</option><option value="internal">Team</option></select></label>
<span id="email-count" role="status" aria-live="polite">${cards.length} previews</span>
</div>
${renderPasteTable(catalog?.pasteTargets)}
${body}
</main>
</div>
${jsonScript('paste-data', payload)}
<script>
const paste = JSON.parse(document.getElementById('paste-data').textContent);
const search = document.getElementById('email-search');
const group = document.getElementById('email-group');
const audience = document.getElementById('email-audience');
function filterEmails() {
  let visible = 0;
  for (const card of document.querySelectorAll('.card')) {
    card.hidden = !(card.dataset.search.includes(search.value.trim().toLowerCase()) && (!group.value || card.dataset.group === group.value) && (!audience.value || card.dataset.audience === audience.value));
    if (!card.hidden) visible++;
  }
  for (const section of document.querySelectorAll('main > section')) section.hidden = !section.querySelector('.card:not([hidden])');
  document.getElementById('email-count').textContent = visible + ' previews';
}
search.addEventListener('input', filterEmails);
group.addEventListener('change', filterEmails);
audience.addEventListener('change', filterEmails);
document.querySelector('nav').addEventListener('click', (e) => { if (e.target.closest('a')) { search.value = ''; group.value = ''; audience.value = ''; filterEmails(); } });
for (const a of document.querySelectorAll('a[data-admin]')) a.href = paste[a.dataset.admin]?.adminUrl ?? '#';
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove(); return ok;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-copy]');
  if (!b) return;
  const entry = paste[b.dataset.copy];
  const label = b.textContent;
  const ok = entry && (await copyText(entry[b.dataset.part]));
  b.textContent = ok ? 'Copied' : 'Copy failed'; b.classList.toggle('done', Boolean(ok));
  setTimeout(() => { b.textContent = label; b.classList.remove('done'); }, 1500);
});
// Height follows the content; a mobile frame whose content is wider than
// 375 px gets a red banner, since the reader would have to scroll sideways.
function fit(f) {
  try {
    const doc = f.contentDocument.documentElement;
    f.style.height = (doc.scrollHeight + 2) + 'px';
    const card = f.closest('.card');
    if (f.classList.contains('mobile') && doc.scrollWidth > doc.clientWidth + 1 && !card.querySelector('.overflow')) {
      const b = document.createElement('div');
      b.className = 'banner error overflow';
      b.innerHTML = '<strong>Overflows the 375 px mobile width</strong> (content is ' + doc.scrollWidth + ' px wide): a fixed width attribute without a width:100% style.';
      card.querySelector('header').after(b);
      card.classList.add('has-errors');
    }
  } catch {}
}
for (const f of document.querySelectorAll('iframe')) { f.addEventListener('load', () => fit(f)); if (f.contentDocument?.readyState === 'complete') fit(f); }
${
  live
    ? `try { const y = sessionStorage.getItem('emails-scroll'); if (y) { sessionStorage.removeItem('emails-scroll'); window.addEventListener('load', () => scrollTo(0, Number(y))); } } catch {}
new EventSource('/events').onmessage = () => { try { sessionStorage.setItem('emails-scroll', String(scrollY)); } catch {} location.reload(); };`
    : ''
}
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Static build
// ---------------------------------------------------------------------------

// Replace remote <img src> in the emails with data URIs so the shared file
// makes no requests. The paste payload keeps the original URLs.
async function inlineImages(catalog) {
  const urls = new Set();
  for (const c of catalog.cards) for (const m of (c.html ?? '').matchAll(/src="(https:\/\/[^"]+)"/g)) urls.add(m[1]);
  const data = new Map();
  for (const url of urls) {
    try {
      const res = await fetch(url.replaceAll('&amp;', '&'), {signal: AbortSignal.timeout(10000)});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? 'image/png';
      data.set(url, `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`);
    } catch (err) {
      console.warn(`emails:build: kept remote image ${url} (${err.message})`);
    }
  }
  for (const c of catalog.cards) {
    if (c.html) c.html = c.html.replace(/src="(https:\/\/[^"]+)"/g, (m, u) => (data.has(u) ? `src="${data.get(u)}"` : m));
  }
}

async function build(out) {
  const {catalog, error} = await renderCatalog();
  if (error) throw new Error(error);
  await inlineImages(catalog);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, renderPage({catalog, live: false}));
  // One file per card next to the gallery, for opening a single mail on its own.
  const dir = path.join(path.dirname(out), 'cards');
  fs.mkdirSync(dir, {recursive: true});
  for (const c of catalog.cards) {
    if (c.html) fs.writeFileSync(path.join(dir, `${c.id}.html`), c.html);
    else if (c.text) fs.writeFileSync(path.join(dir, `${c.id}.txt`), `Subject: ${c.subject}\n\n${c.text}\n`);
  }
  const broken = catalog.cards.filter((c) => c.errors.length).length;
  console.log(`Wrote ${catalog.cards.length} cards to ${out}${broken ? `; ${broken} with problems` : ''}`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function serve(port) {
  let state = {catalog: null, error: null};
  const clients = new Set();
  const refresh = async () => {
    const started = Date.now();
    const r = await renderCatalog();
    state = r.error ? {catalog: state.catalog, error: r.error} : {catalog: r.catalog, error: null};
    const broken = state.catalog?.cards.filter((c) => c.errors.length).length ?? 0;
    console.log(`${new Date().toLocaleTimeString()} rendered in ${Date.now() - started} ms${r.error ? ': catalog failed' : broken ? `: ${broken} card(s) with problems` : ''}`);
    for (const res of clients) res.write('data: reload\n\n');
  };
  await refresh();

  let timer = null;
  let running = Promise.resolve();
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(refresh);
    }, 120);
  };
  for (const w of WATCH) {
    fs.watch(path.join(ROOT, w.dir), {recursive: w.recursive}, (_event, file) => {
      if (!file) return schedule();
      const name = String(file);
      if (w.files && !w.files.includes(name)) return;
      if (/(^|\/)(\.|node_modules)|~$|\.swp$/.test(name)) return;
      schedule();
    });
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/' || req.url?.startsWith('/?')) {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(renderPage({...state, live: true}));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Email preview on http://localhost:${port} (watching templates, fixtures and builders; Ctrl-C to stop)`);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: npm run emails:preview [-- --port N] | npm run emails:build [-- --out PATH]');
    return;
  }
  if (opts.build) {
    let out = opts.out;
    if (!out) {
      const ws = workspaceRoot();
      if (!ws) throw new Error('no workspace root (repos.json) above this checkout; pass --out PATH');
      out = path.join(ws, '.review', 'emails', 'index.html');
    }
    await build(out);
    return;
  }
  await serve(opts.port);
}

main().catch((err) => {
  console.error(`emails: ${err.message}`);
  process.exit(1);
});
