#!/usr/bin/env node
/**
 * A local stand-in for Discord and the Shopify Admin API, for running the
 * support tickets end to end on the dev server without posting to the real
 * Discord or touching the real Shopify store.
 *
 *   node scripts/support-stub.mjs            # listens on :5196
 *
 * Point the dev server at it in `.env.local` (dev only, a build ignores
 * these):
 *
 *   SUPPORT_DEV_DISCORD_API=http://localhost:5196/discord
 *   SUPPORT_DEV_SHOPIFY_ADMIN_URL=http://localhost:5196/shopify
 *   DISCORD_BOT_TOKEN=stub
 *   DISCORD_SUPPORT_CHANNEL_ID=100
 *   DISCORD_GUILD_ID=7
 *
 * Play the team: `curl -XPOST localhost:5196/control/staff -d
 * '{"ref":"OD-XXXX-XXXX","content":"Hello"}'`. `GET /control/state` shows
 * every thread. Shopify knows one customer, jan@example.com, with order
 * #1042. State lives in memory and resets on restart.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 5196);
const SUPPORT_CHANNEL = '100';
let seq = 1_300_000_000_000_000_000n;
const nextId = () => (seq += 4096n).toString();

const threads = new Map();
const channelPosts = [];
const files = new Map();
const shopifyWrites = [];

const bot = {id: 'bot', username: 'OpenDrone', global_name: null, bot: true};

function addMessage(thread, content, author, attachments = []) {
  thread.archived = false;
  const m = {id: nextId(), content, timestamp: new Date().toISOString(), author, attachments, reactions: []};
  thread.messages.push(m);
  return m;
}

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
const CUSTOMERS = [{id: 'gid://shopify/Customer/1', email: 'jan@example.com', numberOfOrders: 2, metafield: null, orders: {nodes: [JAN_ORDER]}}];

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function discord(req, res, path, body) {
  const parts = path.split('/').filter(Boolean);
  // channels/:id[/...]
  if (parts[0] === 'channels') {
    const id = parts[1];
    const thread = threads.get(id);
    if (parts.length === 2 && req.method === 'GET') {
      if (id === SUPPORT_CHANNEL) return send(res, 200, {id, type: 0});
      if (!thread || thread.deleted) return send(res, 404, {message: 'Unknown Channel'});
      return send(res, 200, {id, type: 12, thread_metadata: {archived: thread.archived, locked: thread.locked}});
    }
    if (parts.length === 2 && req.method === 'PATCH') {
      if (!thread) return send(res, 404, {});
      Object.assign(thread, JSON.parse(body.toString()));
      return send(res, 200, {id});
    }
    if (parts.length === 2 && req.method === 'DELETE') {
      if (thread) thread.deleted = true;
      return send(res, 204);
    }
    if (parts[2] === 'threads' && req.method === 'POST') {
      const payload = JSON.parse(body.toString());
      const tid = nextId();
      threads.set(tid, {id: tid, name: payload.name, archived: false, locked: false, deleted: false, messages: []});
      return send(res, 200, {id: tid, name: payload.name});
    }
    if (parts[2] === 'messages' && req.method === 'POST') {
      let payload;
      const attachments = [];
      const type = req.headers['content-type'] || '';
      if (type.startsWith('multipart/form-data')) {
        const form = await new Request('http://stub/', {method: 'POST', headers: {'content-type': type}, body}).formData();
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
      return send(res, 200, addMessage(thread, payload.content, bot, attachments));
    }
    if (parts[2] === 'messages' && req.method === 'GET' && parts.length === 3) {
      if (!thread || thread.deleted) return send(res, 404, {});
      const after = new URL(req.url, 'http://x').searchParams.get('after');
      const list = thread.messages.filter((m) => !after || BigInt(m.id) > BigInt(after)).reverse();
      return send(res, 200, list);
    }
    if (parts[2] === 'messages' && req.method === 'GET' && parts.length === 4) {
      const m = thread?.messages.find((x) => x.id === parts[3]);
      return m ? send(res, 200, m) : send(res, 404, {});
    }
    if (parts[2] === 'messages' && parts[4] === 'reactions') {
      return req.method === 'GET' ? send(res, 200, []) : send(res, 204);
    }
  }
  if (parts[0] === 'guilds' && parts[2] === 'members') return send(res, 200, []);
  return send(res, 404, {message: `stub: no route ${req.method} ${path}`});
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
  if (query.includes('SupportTicketsRead')) return data({customer: {metafield: CUSTOMERS[0].metafield}});
  if (query.includes('SupportTickets(')) {
    CUSTOMERS[0].metafield = {value: variables.metafields[0].value};
    shopifyWrites.push({op: 'metafieldsSet', variables});
    return data({metafieldsSet: {userErrors: []}});
  }
  if (query.includes('SupportTag')) {
    shopifyWrites.push({op: 'tagsAdd', variables});
    return data({tagsAdd: {userErrors: []}});
  }
  return send(res, 400, {errors: [{message: 'stub: unknown query'}]});
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    try {
      if (url.pathname.startsWith('/discord/')) return await discord(req, res, url.pathname.slice('/discord'.length), body);
      if (url.pathname === '/shopify') return shopify(res, body);
      if (url.pathname.startsWith('/cdn/')) {
        const f = files.get(url.pathname.split('/')[2]);
        if (!f) return send(res, 404, {});
        res.writeHead(200, {'Content-Type': f.type || 'application/octet-stream'});
        return res.end(f.data);
      }
      if (url.pathname === '/control/staff' && req.method === 'POST') {
        const {ref, content, name = 'Jan Peeters', command} = JSON.parse(body.toString());
        const thread = [...threads.values()].find((t) => t.name.startsWith(ref));
        if (!thread) return send(res, 404, {error: 'no thread for ref'});
        if (command === 'lock') thread.locked = true;
        const m = content ? addMessage(thread, content, {id: 'staff-1', username: 'jan', global_name: name, bot: false}) : null;
        return send(res, 200, {ok: true, id: m?.id});
      }
      if (url.pathname === '/control/state') {
        return send(res, 200, {
          threads: [...threads.values()].map((t) => ({...t, messages: t.messages.map((m) => ({id: m.id, bot: m.author.bot, content: m.content, files: m.attachments.map((a) => a.filename)}))})),
          channelPosts,
          shopifyWrites,
        });
      }
      return send(res, 404, {});
    } catch (err) {
      return send(res, 500, {error: String(err)});
    }
  })
  .listen(PORT, () => console.warn(`support stub on http://localhost:${PORT}`));
