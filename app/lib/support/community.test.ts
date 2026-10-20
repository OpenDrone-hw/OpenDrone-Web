import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {COMMUNITY_TAKEOVER_NOTE, decideRoute, hardTeamReason, routeHint, routeTicket, syncCommunity, takeOver} from './community.ts';
import {createDraftStore} from './ai-drafts.ts';
import {createStore} from './store.ts';
import {createTicket, type Deps, type NewTicketInput, type SupportEnv} from './tickets.ts';
import {fakeChatFpv, fakeDiscord, fakeR2, testD1} from './testing.ts';

const skip = (await testD1()) ? false : 'node:sqlite unavailable';

const ENV: SupportEnv = {
  DISCORD_BOT_TOKEN: 'bot',
  DISCORD_SUPPORT_CHANNEL_ID: '42',
  DISCORD_GUILD_ID: '7',
  DISCORD_HELP_CHANNEL_ID: '99',
  SUPPORT_SESSION_SECRET: 'test-secret',
  SUPPORT_CRM_API: '1',
  SUPPORT_COMMUNITY_ROUTE: '1',
};

let clock = Date.parse('2026-10-12T09:00:00Z');

async function setup(env: Partial<SupportEnv> = {}, route: 'community' | 'team' | 'none' = 'community') {
  const db = (await testD1())!;
  const discord = fakeDiscord({now: () => clock});
  const r2 = fakeR2();
  const ai = fakeChatFpv({
    draft: (_req, n) => ({draftId: `dr_${n}`, draft: 'Recalibrate the gyro first [1].', citations: [], confidence: 0.8, note: 'ok', ...(route !== 'none' ? {route} : {})}),
  });
  const deps: Deps = {
    env: {...ENV, ...env},
    store: createStore(db),
    discord: discord.client,
    files: r2.bucket,
    chatfpv: {client: ai.client, drafts: createDraftStore(db)},
    now: () => clock,
    origin: 'https://opendrone.test',
  };
  return {deps, discord, r2, ai};
}

const input = (over: Partial<NewTicketInput> = {}): NewTicketInput => ({
  topic: 'product',
  name: 'Jan Peeters',
  email: 'jan@example.com',
  orderNumber: null,
  product: 'OpenFC F4',
  firmware: null,
  message: 'The gyro drifts after a power cycle on my bench setup. How do I recalibrate it?',
  communityConsent: true,
  ...over,
});

beforeEach(() => {
  clock = Date.parse('2026-10-12T09:00:00Z');
});

describe('hard rules force the team route', () => {
  const t = {topic: 'product' as const, orderNumber: null, name: 'Jan Peeters', email: 'jan@example.com'};
  const cases: Array<[string, string]> = [
    ['order #1042 has not shipped', 'order'],
    ['where is my shipment', 'order'],
    ['please send it to Kerkstraat 5, 9000 Gent', 'address'],
    ['my postcode changed', 'address'],
    ['I paid twice, can I get an invoice', 'payment'],
    ['the board is dead on arrival, I want a refund', 'warranty'],
    ['is the warranty valid after reflashing', 'warranty'],
    ['we are a company looking for wholesale prices', 'internal'],
    ['mail me at jan@example.com', 'personal'],
    ['call me on +32 475 12 34 56', 'personal'],
    ['Jan Peeters here, gyro drifts', 'personal'],
  ];
  for (const [text, reason] of cases) {
    it(`"${text}" -> ${reason}`, () => assert.equal(hardTeamReason(t, [text]), reason));
  }

  it('forces team for the order and warranty topics and for any order number', () => {
    assert.equal(hardTeamReason({...t, topic: 'order'}, ['gyro drifts']), 'topic');
    assert.equal(hardTeamReason({...t, topic: 'warranty'}, ['gyro drifts']), 'topic');
    assert.equal(hardTeamReason({...t, orderNumber: '#1042'}, ['gyro drifts']), 'order');
  });

  it('lets a plain technical question through', () => {
    assert.equal(hardTeamReason(t, ['The gyro drifts after a power cycle. How do I recalibrate?']), null);
  });
});

describe('routeHint', () => {
  const ticket = {route: 'team' as const, topic: 'product' as const, orderNumber: null, name: 'Jan Peeters', email: 'jan@example.com', communityConsent: true};
  it('suggests the forum for a plain question with consent, whatever the flag', () => {
    assert.deepEqual(routeHint(ticket, ['The gyro drifts after a power cycle.']), {route: 'community', reason: 'candidate'});
  });
  it('names the hard rule first, then the missing consent', () => {
    assert.deepEqual(routeHint(ticket, ['where is my order']), {route: 'team', reason: 'order'});
    assert.deepEqual(routeHint({...ticket, communityConsent: false}, ['where is my order']), {route: 'team', reason: 'order'});
    assert.deepEqual(routeHint({...ticket, communityConsent: false}, ['The gyro drifts.']), {route: 'team', reason: 'no_consent'});
    assert.deepEqual(routeHint({...ticket, topic: 'warranty'}, ['The gyro drifts.']), {route: 'team', reason: 'topic'});
  });
  it('reports a posted ticket as posted', () => {
    assert.deepEqual(routeHint({...ticket, route: 'community'}, ['where is my order']), {route: 'community', reason: 'posted'});
  });
});

describe('decideRoute', () => {
  const ticket = {topic: 'product' as const, orderNumber: null, name: 'Jan Peeters', email: 'jan@example.com', communityConsent: true};
  const texts = ['The gyro drifts after a power cycle.'];
  it('is community only with the flag, consent and a community label', () => {
    assert.equal(decideRoute({ticket, texts, label: 'community', enabled: true}).route, 'community');
    assert.equal(decideRoute({ticket, texts, label: 'community', enabled: false}).route, 'team');
    assert.equal(decideRoute({ticket: {...ticket, communityConsent: false}, texts, label: 'community', enabled: true}).reason, 'no_consent');
    assert.equal(decideRoute({ticket, texts, label: 'team', enabled: true}).reason, 'label');
    assert.equal(decideRoute({ticket, texts, label: undefined, enabled: true}).route, 'team');
  });
  it('lets a hard rule beat the AI label', () => {
    assert.deepEqual(decideRoute({ticket, texts: ['I want a refund'], label: 'community', enabled: true}), {route: 'team', reason: 'warranty'});
  });
});

describe('the community route', {skip}, () => {
  it('posts an anonymised question and relays member replies back', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    await new Promise((r) => setTimeout(r, 20));
    const row = (await deps.store.getTicket(t.ref))!;
    assert.equal(row.route, 'community');
    assert.ok(row.communityPostId);
    assert.equal(discord.forumPosts.length, 1);
    assert.equal(discord.forumPosts[0]!.channel, '99');
    const post = discord.threads.get(row.communityPostId!)!;
    const text = `${post.name}\n${post.messages.map((m) => m.content).join('\n')}`;
    assert.ok(text.includes('gyro drifts'));
    for (const secret of ['Jan', 'Peeters', 'jan@example.com', t.ref]) assert.ok(!text.includes(secret), `leaks ${secret}`);
    assert.equal(discord.threads.size, 1, 'no staff thread for the ticket');
    assert.ok((await deps.store.messages(t.ref)).some((m) => m.role === 'system' && m.body === 'sent_to_community'));

    discord.member(row.communityPostId!, 'Hold the quad still for 5 s after power-up, then run calibrate. Mail me at x@y.com');
    discord.member(row.communityPostId!, 'a'.repeat(20) + ' second tip');
    clock += 60_000;
    const synced = await syncCommunity(deps, row, {force: true});
    const msgs = (await deps.store.messages(t.ref)).filter((m) => m.role === 'community');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.author, 'Community');
    assert.ok(!msgs[0]!.body.includes('x@y.com'), 'member text is scrubbed');
    assert.ok(synced.lastCommunityAt);
    // Run again: nothing is copied twice.
    await syncCommunity(deps, synced, {force: true});
    assert.equal((await deps.store.messages(t.ref)).filter((m) => m.role === 'community').length, 2);
  });

  it('stays with the team without consent, on a hard rule, on a team label or while the flag is off', async () => {
    const cases: Array<[string, Partial<NewTicketInput>, 'community' | 'team' | 'none', Partial<SupportEnv>]> = [
      ['no consent', {communityConsent: false}, 'community', {}],
      ['hard rule', {message: 'The gyro drifts and I want a refund for the board.'}, 'community', {}],
      ['order number', {orderNumber: '#1042'}, 'community', {}],
      ['team label', {}, 'team', {}],
      ['no label', {}, 'none', {}],
      ['flag off', {}, 'community', {SUPPORT_COMMUNITY_ROUTE: '0'}],
      ['no help channel', {}, 'community', {DISCORD_HELP_CHANNEL_ID: ''}],
    ];
    for (const [name, over, label, env] of cases) {
      const {deps, discord} = await setup(env, label);
      const t = await createTicket(deps, input(over));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal((await deps.store.getTicket(t.ref))!.route, 'team', name);
      assert.equal(discord.forumPosts.length, 0, name);
    }
  });

  it('leaves the ticket with the team when the forum post fails', async () => {
    const { deps } = await setup();
    deps.discord = {...deps.discord, createForumPostIn: async () => { throw new Error('boom'); }};
    const t = await createTicket(deps, input());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await deps.store.getTicket(t.ref))!.route, 'team');
  });

  it('does not move a ticket the team already answered', async () => {
    const { deps, discord } = await setup({}, 'none');
    const t = await createTicket(deps, input());
    await deps.store.updateTicket(t.ref, {lastStaffAt: clock});
    const decision = await routeTicket(deps, (await deps.store.getTicket(t.ref))!, 'community');
    assert.equal(decision.route, 'team');
    assert.equal(discord.forumPosts.length, 0);
  });

  it('returns the question to the team when the post is deleted, and on takeover tells the forum', async () => {
    const { deps, discord } = await setup();
    const t = await createTicket(deps, input());
    await new Promise((r) => setTimeout(r, 20));
    let row = (await deps.store.getTicket(t.ref))!;
    const postId = row.communityPostId!;
    row = await takeOver(deps, row, 'stan');
    assert.equal(row.route, 'team');
    assert.equal(row.assignee, 'stan');
    assert.ok(discord.threads.get(postId)!.messages.some((m) => m.content === COMMUNITY_TAKEOVER_NOTE));

    const other = await createTicket(deps, input({message: 'Which PID values suit a 5 inch build on this board?'}));
    await new Promise((r) => setTimeout(r, 20));
    const o = (await deps.store.getTicket(other.ref))!;
    discord.threads.get(o.communityPostId!)!.deleted = true;
    clock += 60_000;
    const back = await syncCommunity(deps, o, {force: true});
    assert.equal(back.route, 'team');
    assert.equal(back.communityPostId, null);
  });
});
