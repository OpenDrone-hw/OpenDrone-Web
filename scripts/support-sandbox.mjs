#!/usr/bin/env node
/**
 * Support sandbox: a local, in-memory stand-in for the Discord API, the
 * Shopify Admin API and an empty Storefront catalogue, so the ticket system
 * runs end to end on the dev server without posting to the real Discord or
 * touching the real Shopify store.
 * README "Test support locally" has the walkthrough.
 *
 *   npm run support:sandbox -- [--port 5196] [--dev-port 5195] [--moderation off|enforce] [--write-env]
 *       applies migrations/ to this worktree's local D1, prints (or with
 *       --write-env writes) the .env.local lines for the dev server, and
 *       serves the fake APIs until stopped
 *
 *   npm run support:staff -- <command> <ticket-ref> [text]     (act as the team)
 *       reply  OD-XXXX-XXXX "text"   a staff reply
 *       note   OD-XXXX-XXXX "text"   a `//` internal note
 *       waiting|close|open OD-XXXX-XXXX   the thread commands
 *       lock   OD-XXXX-XXXX          lock the thread (closes the ticket)
 *       approve OD-XXXX-XXXX [id]    a moderator ✅ on the last (or given) staff message
 *       edit   OD-XXXX-XXXX [id] "text"   edit the last (or given) staff message
 *       delete OD-XXXX-XXXX [id]     delete the last (or given) staff message
 *       state  [OD-XXXX-XXXX]        threads, metadata posts and Shopify writes as JSON
 *     SUPPORT_SANDBOX_PORT selects the sandbox (default 5196).
 *
 * The fake Shopify knows one customer, jan@example.com, with order #1042
 * (preorder batch 2). The fake guild has one moderator (role 555). State
 * resets when the sandbox stops. No dependencies beyond Node.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SUPPORT_CHANNEL = '100';
const GUILD = '7';
const MOD_ROLE = '555';
const MODERATOR = {id: 'mod-1', username: 'mod', global_name: 'Mia Moderator', bot: false};
const STAFF = {id: 'staff-1', username: 'sam', global_name: 'Sam Support', bot: false};
const BOT = {id: 'bot', username: 'OpenDrone', global_name: null, bot: true};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// Staff CLI: `support-sandbox.mjs staff <command> ...`
// ---------------------------------------------------------------------------

if (process.argv[2] === 'staff') {
  const [command, ref, ...rest] = process.argv.slice(3);
  const port = process.env.SUPPORT_SANDBOX_PORT || '5196';
  const commands = ['reply', 'note', 'waiting', 'close', 'open', 'lock', 'approve', 'edit', 'delete', 'state'];
  if (!commands.includes(command) || (command !== 'state' && !ref)) {
    console.error(`usage: npm run support:staff -- <${commands.join('|')}> <ticket-ref> [text]`);
    process.exit(2);
  }
  const res = await fetch(`http://localhost:${port}/control/${command}`, {
    method: command === 'state' ? 'GET' : 'POST',
    ...(command === 'state' ? {} : {body: JSON.stringify({ref, text: rest.join(' ')})}),
  }).catch(() => null);
  if (!res) {
    console.error(`no sandbox on port ${port}: start it with npm run support:sandbox`);
    process.exit(1);
  }
  const body = await res.json();
  const out = command === 'state' && ref ? {threads: body.threads.filter((t) => t.name.startsWith(ref))} : body;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(res.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Sandbox server
// ---------------------------------------------------------------------------

const PORT = Number(arg('port', process.env.SUPPORT_SANDBOX_PORT || 5196));
const DEV_PORT = Number(arg('dev-port', 5195));
const MODERATION = arg('moderation', 'off');

let seq = 1_300_000_000_000_000_000n;
const nextId = () => (seq += 4096n).toString();
const threads = new Map();
const channelPosts = [];
const files = new Map();
const shopifyWrites = [];

function addMessage(thread, content, author, attachments = []) {
  thread.archived = false;
  const m = {id: nextId(), content, timestamp: new Date().toISOString(), edited_timestamp: null, author, attachments, reactions: [], reactors: []};
  thread.messages.push(m);
  return m;
}

const publicMessage = (m) => ({...m, reactors: undefined});

const JAN_ORDER = {
  name: '#1042',
  email: 'jan@example.com',
  customer: {id: 'gid://shopify/Customer/1'},
  createdAt: '2026-08-02T10:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['preorder', 'batch:OD-FC-F4:2'],
  lineItems: {nodes: [{sku: 'OD-FC-F4', title: 'OpenFC F4', quantity: 1}]},
};
const CUSTOMERS = [
  {id: 'gid://shopify/Customer/1', email: 'jan@example.com', numberOfOrders: 2, metafield: null, orders: {nodes: [JAN_ORDER]}},
];

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function discord(req, res, url, body) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  if (parts[0] === 'guilds' && parts[2] === 'members') {
    const members = [{user: {id: MODERATOR.id}, roles: [MOD_ROLE]}, {user: {id: STAFF.id}, roles: []}];
    // GET /guilds/:id/members/:user is one member (moderation.ts hasRole); without :user, the list.
    if (parts[3]) {
      const member = members.find((m) => m.user.id === parts[3]);
      return member ? send(res, 200, member) : send(res, 404, {message: 'Unknown Member', code: 10007});
    }
    return send(res, 200, url.searchParams.get('after') ? [] : members);
  }
  if (parts[0] !== 'channels') return send(res, 404, {message: `sandbox: no route ${req.method} ${url.pathname}`});
  const id = parts[1];
  const thread = threads.get(id);
  if (parts.length === 2) {
    if (req.method === 'GET') {
      if (id === SUPPORT_CHANNEL) return send(res, 200, {id, type: 0});
      if (!thread || thread.deleted) return send(res, 404, {message: 'Unknown Channel'});
      return send(res, 200, {id, type: 12, thread_metadata: {archived: thread.archived, locked: thread.locked}});
    }
    if (req.method === 'PATCH') {
      if (!thread) return send(res, 404, {});
      Object.assign(thread, JSON.parse(body.toString()));
      return send(res, 200, {id});
    }
    if (req.method === 'DELETE') {
      if (thread) thread.deleted = true;
      return send(res, 204);
    }
  }
  if (parts[2] === 'threads' && req.method === 'POST') {
    const payload = JSON.parse(body.toString());
    const tid = nextId();
    threads.set(tid, {id: tid, name: payload.name, archived: false, locked: false, deleted: false, messages: []});
    if (payload.message) addMessage(threads.get(tid), payload.message.content, BOT);
    return send(res, 200, {id: tid, name: payload.name});
  }
  if (parts[2] !== 'messages') return send(res, 404, {});
  if (req.method === 'POST' && parts.length === 3) {
    let payload;
    const attachments = [];
    const type = req.headers['content-type'] || '';
    if (type.startsWith('multipart/form-data')) {
      const form = await new Request('http://sandbox/', {method: 'POST', headers: {'content-type': type}, body}).formData();
      payload = JSON.parse(String(form.get('payload_json')));
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('files[')) continue;
        const aid = nextId();
        files.set(aid, {name: value.name, type: value.type, data: Buffer.from(await value.arrayBuffer())});
        attachments.push({id: aid, filename: value.name, size: value.size, url: `http://localhost:${PORT}/cdn/${aid}/${encodeURIComponent(value.name)}`});
      }
    } else {
      payload = JSON.parse(body.toString());
    }
    if (!thread) {
      channelPosts.push({channel: id, content: payload.content});
      return send(res, 200, {id: nextId()});
    }
    if (thread.locked || thread.deleted) return send(res, 403, {});
    return send(res, 200, publicMessage(addMessage(thread, payload.content, BOT, attachments)));
  }
  if (!thread || thread.deleted) return send(res, 404, {});
  if (req.method === 'GET' && parts.length === 3) {
    // Like Discord: with `after`, the oldest `limit` after it; without, the newest `limit`; newest first.
    const after = url.searchParams.get('after');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const list = after
      ? thread.messages.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit)
      : thread.messages.slice(-limit);
    return send(res, 200, list.reverse().map(publicMessage));
  }
  const message = thread.messages.find((m) => m.id === parts[3]);
  if (!message) return send(res, 404, {});
  if (parts.length === 4 && req.method === 'DELETE') {
    thread.messages = thread.messages.filter((m) => m !== message);
    return send(res, 204);
  }
  if (parts.length === 4) return send(res, 200, publicMessage(message));
  if (parts[4] === 'reactions') {
    const emoji = decodeURIComponent(parts[5] ?? '');
    if (req.method === 'GET') return send(res, 200, message.reactors.filter((r) => r.emoji === emoji).map((r) => ({id: r.user})));
    const r = message.reactions.find((x) => x.emoji.name === emoji);
    if (r) r.count += 1;
    else message.reactions.push({emoji: {name: emoji}, count: 1, me: true});
    message.reactors.push({emoji, user: BOT.id});
    return send(res, 204);
  }
  return send(res, 404, {});
}

function shopify(res, body) {
  const {query, variables} = JSON.parse(body.toString());
  const data = (d) => send(res, 200, {data: d});
  if (query.includes('SupportCustomer')) {
    const email = String(variables.q).replace(/^email:"|"$/g, '').toLowerCase();
    return data({customers: {nodes: CUSTOMERS.filter((c) => c.email === email)}});
  }
  if (query.includes('SupportOrder')) {
    const name = String(variables.q).replace(/^name:"|"$/g, '');
    return data({orders: {nodes: [JAN_ORDER].filter((o) => o.name === name)}});
  }
  if (query.includes('SupportTicketsRead')) {
    return data({customer: {metafield: CUSTOMERS.find((c) => c.id === variables.id)?.metafield ?? null}});
  }
  if (query.includes('SupportTickets(')) {
    const mf = variables.metafields[0];
    const c = CUSTOMERS.find((x) => x.id === mf.ownerId);
    if (c) c.metafield = {value: mf.value};
    shopifyWrites.push({op: 'metafieldsSet', ownerId: mf.ownerId, value: JSON.parse(mf.value)});
    return data({metafieldsSet: {userErrors: []}});
  }
  if (query.includes('SupportTag')) {
    shopifyWrites.push({op: 'tagsAdd', id: variables.id, tags: variables.tags});
    return data({tagsAdd: {userErrors: []}});
  }
  return send(res, 400, {errors: [{message: 'sandbox: unknown query'}]});
}

const STAFF_TEXT = {note: (t) => `// ${t || 'internal note'}`, waiting: () => '!waiting', close: () => '!close', open: () => '!open'};

function control(req, res, url, body) {
  const command = url.pathname.split('/')[2];
  if (command === 'state') {
    return send(res, 200, {
      threads: [...threads.values()].map((t) => ({
        name: t.name,
        id: t.id,
        archived: t.archived,
        locked: t.locked,
        deleted: t.deleted,
        messages: t.messages.map((m) => ({
          reactions: m.reactions.map((r) => r.emoji.name),
          id: m.id,
          from: m.author.bot ? 'bot' : m.author.global_name,
          content: m.content,
          files: m.attachments.map((a) => a.filename),
          approvedBy: m.reactors.filter((r) => r.user !== BOT.id).map((r) => r.user),
        })),
      })),
      metadataPosts: channelPosts,
      shopifyWrites,
    });
  }
  const {ref, text: raw = ''} = JSON.parse(body.toString() || '{}');
  // `approve|edit|delete REF <id> [text]`: a leading message id picks the message.
  const picked = ['approve', 'edit', 'delete'].includes(command) ? raw.trim().match(/^(\d{6,})(?:\s+([\s\S]*))?$/) : null;
  const id = picked?.[1];
  const text = picked ? (picked[2] ?? '') : raw;
  const thread = [...threads.values()].find((t) => t.name.startsWith(`${ref} `));
  if (!thread) return send(res, 404, {error: `no thread for ${ref}`});
  if (command === 'lock') {
    thread.locked = true;
    return send(res, 200, {ok: true, locked: true});
  }
  if (command === 'approve') {
    const staffMessages = thread.messages.filter((m) => !m.author.bot);
    const m = id ? thread.messages.find((x) => x.id === id) : staffMessages.at(-1);
    if (!m) return send(res, 404, {error: 'no staff message to approve'});
    const r = m.reactions.find((x) => x.emoji.name === '✅');
    if (r) r.count += 1;
    else m.reactions.push({emoji: {name: '✅'}, count: 1, me: false});
    m.reactors.push({emoji: '✅', user: MODERATOR.id});
    return send(res, 200, {ok: true, approved: m.id});
  }
  if (command === 'edit' || command === 'delete') {
    const m = id ? thread.messages.find((x) => x.id === id) : thread.messages.filter((x) => !x.author.bot).at(-1);
    if (!m || m.author.bot) return send(res, 404, {error: 'no staff message to change'});
    if (command === 'delete') {
      thread.messages = thread.messages.filter((x) => x !== m);
      return send(res, 200, {ok: true, deleted: m.id});
    }
    if (!text) return send(res, 400, {error: 'edit needs text'});
    m.content = text;
    m.edited_timestamp = new Date().toISOString();
    return send(res, 200, {ok: true, edited: m.id, content: text});
  }
  if (command === 'reply' && !text) return send(res, 400, {error: 'reply needs text'});
  const content = command === 'reply' ? text : STAFF_TEXT[command]?.(text);
  if (!content) return send(res, 404, {error: `unknown command ${command}`});
  if (thread.locked || thread.deleted) return send(res, 403, {error: 'thread is locked or deleted'});
  const m = addMessage(thread, content, STAFF);
  return send(res, 200, {ok: true, id: m.id, content});
}

// ---------------------------------------------------------------------------
// Start: local D1, env lines, server
// ---------------------------------------------------------------------------

const ENV_LINES = [
  `SUPPORT_DEV_DISCORD_API=http://localhost:${PORT}/discord`,
  `SUPPORT_DEV_SHOPIFY_ADMIN_URL=http://localhost:${PORT}/shopify`,
  'DISCORD_BOT_TOKEN=sandbox',
  `DISCORD_GUILD_ID=${GUILD}`,
  `DISCORD_SUPPORT_CHANNEL_ID=${SUPPORT_CHANNEL}`,
  'DISCORD_STAFF_METADATA_CHANNEL_ID=900',
  `SUPPORT_MOD_ROLE_ID=${MOD_ROLE}`,
  `SUPPORT_MODERATION_MODE=${MODERATION}`,
  'SUPPORT_SESSION_SECRET=sandbox-only-secret',
  'SUPPORT_CLEANUP_SECRET=sandbox-cleanup-secret',
  // A dummy Admin token: the real one is never sent to the sandbox. (Preorder
  // paid counts, which use the same token, then fail closed on this dev server.)
  'SHOPIFY_ADMIN_API_TOKEN=sandbox-admin-token',
  // A store domain that cannot resolve and an empty sandbox catalogue: no
  // request of this dev server reaches the real store.
  'SHOPIFY_STORE_DOMAIN=support-sandbox.invalid',
  'SHOPIFY_STOREFRONT_TOKEN=sandbox-storefront-token',
  `SUPPORT_DEV_STOREFRONT_URL=http://localhost:${PORT}/storefront`,
  'SUPPORT_SHOPIFY_WRITE_ENABLED=1',
  'SUPPORT_EMAIL_NOTIFY_ENABLED=0',
  // Cloudflare's always-pass test site key; the dev-only skip covers the missing secret.
  'TURNSTILE_SITE_KEY=1x00000000000000000000AA',
  'SUPPORT_TURNSTILE_DEV_SKIP=1',
];

console.warn('support sandbox: applying migrations/ to the local D1 (.wrangler/state)');
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'SUPPORT_DB', '--local', '--config', 'wrangler.toml'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {...process.env, CI: '1'},
});

const envPath = path.join(root, '.env.local');
const envText = `# Written by npm run support:sandbox. Dev server only: a build ignores these.\n${ENV_LINES.join('\n')}\n`;
if (process.argv.includes('--write-env')) {
  writeFileSync(envPath, envText);
  console.warn(`support sandbox: wrote ${path.relative(process.cwd(), envPath) || '.env.local'}`);
} else {
  console.warn(`support sandbox: ${existsSync(envPath) ? '.env.local exists, left alone' : 'no .env.local'}; put these lines in it (or rerun with --write-env):\n\n${envText}`);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://sandbox');
    const body = await readBody(req);
    try {
      if (url.pathname.startsWith('/discord/')) return await discord(req, res, url, body);
      if (url.pathname === '/shopify') return shopify(res, body);
      // Storefront API: an empty catalogue (no products, so no preorder counts either).
      if (url.pathname === '/storefront') return send(res, 200, {data: {products: {pageInfo: {hasNextPage: false}, nodes: []}}});
      if (url.pathname.startsWith('/control/')) return control(req, res, url, body);
      if (url.pathname.startsWith('/cdn/')) {
        const f = files.get(url.pathname.split('/')[2]);
        if (!f) return send(res, 404, {});
        res.writeHead(200, {'Content-Type': f.type || 'application/octet-stream'});
        return res.end(f.data);
      }
      return send(res, 404, {});
    } catch (err) {
      return send(res, 500, {error: String(err)});
    }
  })
  .listen(PORT, () => {
    console.warn(
      [
        `support sandbox: fake Discord and Shopify on http://localhost:${PORT} (moderation ${MODERATION})`,
        `dev server:      VITE_CACHE_DIR=.vite-cache npm run dev -- --port ${DEV_PORT} --strictPort`,
        `open:            http://localhost:${DEV_PORT}/support   (customer jan@example.com, order #1042)`,
        `act as staff:    SUPPORT_SANDBOX_PORT=${PORT} npm run support:staff -- reply OD-XXXX-XXXX "Hello"`,
      ].join('\n'),
    );
  });
