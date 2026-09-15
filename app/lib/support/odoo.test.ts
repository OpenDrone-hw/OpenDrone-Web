import {describe, it, mock, after} from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrFetchOdooTicket,
  hasOdooBridge,
  patchOdooTicketState,
  postOdooMessage,
  searchOdooTickets,
} from './odoo.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/support/odoo.test.ts

const CONFIGURED = {
  SUPPORT_ODOO_URL: 'https://staging.incutec.eu',
  SUPPORT_ODOO_TOKEN: 'test-token',
};

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  mock.method(globalThis, 'fetch', impl);
}

describe('createOrFetchOdooTicket', () => {
  after(() => mock.restoreAll());

  it('returns null (no-op) when SUPPORT_ODOO_TOKEN is unset', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{}', {status: 200});
    });
    const ticket = await createOrFetchOdooTicket(
      {SUPPORT_ODOO_URL: 'https://staging.incutec.eu'},
      {threadId: 't1', email: 'a@example.com', name: 'A', subject: 's'},
    );
    assert.equal(ticket, null);
    assert.equal(calls, 0);
  });

  it('creates a ticket: posts the contract body, returns id/ticket_ref/created', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    stubFetch(async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(
        JSON.stringify({id: 42, ticket_ref: 'SUP-00001', created: true}),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const ticket = await createOrFetchOdooTicket(CONFIGURED, {
      threadId: '999888777',
      email: 'bridge@example.com',
      name: 'Bridge Customer',
      subject: 'ELRS not binding',
    });
    assert.deepEqual(ticket, {id: 42, ticketRef: 'SUP-00001', created: true});
    assert.equal(seenUrl, 'https://staging.incutec.eu/incutec/support/ticket');
    assert.equal(
      (seenInit?.headers as Record<string, string>)['X-Incutec-Support-Token'],
      'test-token',
    );
    const body = JSON.parse(String(seenInit?.body)) as {
      thread_id: string;
      email: string;
      name: string;
      subject: string;
    };
    assert.equal(body.thread_id, '999888777');
    assert.equal(body.email, 'bridge@example.com');
    assert.equal(body.subject, 'ELRS not binding');
  });

  it('fetches an existing ticket idempotently (created: false)', async () => {
    stubFetch(async () =>
      new Response(
        JSON.stringify({id: 42, ticket_ref: 'SUP-00001', created: false}),
        {status: 200, headers: {'content-type': 'application/json'}},
      ),
    );
    const ticket = await createOrFetchOdooTicket(CONFIGURED, {
      threadId: '999888777',
      email: 'bridge@example.com',
      name: 'Bridge Customer',
      subject: 'ignored on an existing thread_id',
    });
    assert.deepEqual(ticket, {id: 42, ticketRef: 'SUP-00001', created: false});
  });

  it('retries once on a network error, then succeeds', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return new Response(
        JSON.stringify({id: 1, ticket_ref: 'SUP-00002', created: true}),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const ticket = await createOrFetchOdooTicket(CONFIGURED, {
      threadId: 't2',
      email: 'a@example.com',
      name: 'A',
      subject: 's',
    });
    assert.equal(calls, 2);
    assert.deepEqual(ticket, {id: 1, ticketRef: 'SUP-00002', created: true});
  });

  it('Odoo down: retries once then returns null without throwing', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      throw new Error('connection refused');
    });
    const ticket = await createOrFetchOdooTicket(CONFIGURED, {
      threadId: 't3',
      email: 'a@example.com',
      name: 'A',
      subject: 's',
    });
    assert.equal(ticket, null);
    assert.equal(calls, 2); // one retry, no more
  });

  it('a 4xx (e.g. 401/404) is not retried', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response(JSON.stringify({error: 'unauthorized'}), {status: 401});
    });
    const ticket = await createOrFetchOdooTicket(CONFIGURED, {
      threadId: 't4',
      email: 'a@example.com',
      name: 'A',
      subject: 's',
    });
    assert.equal(ticket, null);
    assert.equal(calls, 1);
  });

  it('a 5xx is retried once, then gives up', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('boom', {status: 500});
    });
    const ticket = await createOrFetchOdooTicket(CONFIGURED, {
      threadId: 't5',
      email: 'a@example.com',
      name: 'A',
      subject: 's',
    });
    assert.equal(ticket, null);
    assert.equal(calls, 2);
  });
});

describe('postOdooMessage', () => {
  after(() => mock.restoreAll());

  it('returns false when SUPPORT_ODOO_TOKEN is unset', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{}', {status: 200});
    });
    const ok = await postOdooMessage(
      {SUPPORT_ODOO_URL: 'https://staging.incutec.eu'},
      {ticketRef: 'SUP-00001', author: 'Jane Doe', body: 'hi'},
    );
    assert.equal(ok, false);
    assert.equal(calls, 0);
  });

  it('posts author + body to the ticket message endpoint', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    stubFetch(async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(
        JSON.stringify({id: 7, ticket_ref: 'SUP-00001', posted: true}),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const ok = await postOdooMessage(CONFIGURED, {
      ticketRef: 'SUP-00001',
      author: 'Jane Doe',
      body: 'Still not binding after a factory reset.',
    });
    assert.equal(ok, true);
    assert.equal(
      seenUrl,
      'https://staging.incutec.eu/incutec/support/ticket/SUP-00001/message',
    );
    const body = JSON.parse(String(seenInit?.body)) as {
      author: string;
      body: string;
    };
    assert.equal(body.author, 'Jane Doe');
    assert.equal(body.body, 'Still not binding after a factory reset.');
  });

  it('unknown ticket ref (404) resolves false, not thrown', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({error: 'unknown ticket ref'}), {status: 404}),
    );
    const ok = await postOdooMessage(CONFIGURED, {
      ticketRef: 'SUP-99999',
      author: 'Jane Doe',
      body: 'hello',
    });
    assert.equal(ok, false);
  });

  it('Odoo down: retries once then resolves false without throwing', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      throw new Error('connection refused');
    });
    const ok = await postOdooMessage(CONFIGURED, {
      ticketRef: 'SUP-00001',
      author: 'Jane Doe',
      body: 'hello',
    });
    assert.equal(ok, false);
    assert.equal(calls, 2);
  });
});

describe('hasOdooBridge', () => {
  it('true only when SUPPORT_ODOO_TOKEN is set', () => {
    assert.equal(hasOdooBridge(CONFIGURED), true);
    assert.equal(hasOdooBridge({SUPPORT_ODOO_URL: 'https://staging.incutec.eu'}), false);
    assert.equal(hasOdooBridge({}), false);
  });
});

describe('patchOdooTicketState', () => {
  after(() => mock.restoreAll());

  it('returns false when SUPPORT_ODOO_TOKEN is unset', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{}', {status: 200});
    });
    const ok = await patchOdooTicketState(
      {SUPPORT_ODOO_URL: 'https://staging.incutec.eu'},
      'SUP-00001',
      {closed: true},
    );
    assert.equal(ok, false);
    assert.equal(calls, 0);
  });

  it('posts only the provided fields to the state endpoint', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    stubFetch(async (input, init) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({id: 1, ticket_ref: 'SUP-00001', ok: true}),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const ok = await patchOdooTicketState(CONFIGURED, 'SUP-00001', {
      seenCursor: '123',
    });
    assert.equal(ok, true);
    assert.equal(
      seenUrl,
      'https://staging.incutec.eu/incutec/support/ticket/SUP-00001/state',
    );
    assert.deepEqual(seenBody, {seen_cursor: '123'});
  });

  it('sends feedback as a nested object', async () => {
    let seenBody: Record<string, unknown> = {};
    stubFetch(async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({id: 1, ticket_ref: 'SUP-00001', ok: true}),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    await patchOdooTicketState(CONFIGURED, 'SUP-00001', {
      feedback: {speed: 5, helpfulness: 4, overall: 5, notes: 'great'},
    });
    assert.deepEqual(seenBody, {
      feedback: {speed: 5, helpfulness: 4, overall: 5, notes: 'great'},
    });
  });

  it('an error response resolves false, not thrown', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({error: 'unknown ticket ref'}), {status: 404}),
    );
    const ok = await patchOdooTicketState(CONFIGURED, 'SUP-99999', {closed: true});
    assert.equal(ok, false);
  });
});

describe('searchOdooTickets', () => {
  after(() => mock.restoreAll());

  it('returns [] when SUPPORT_ODOO_TOKEN is unset', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{"tickets": []}', {status: 200});
    });
    const tickets = await searchOdooTickets(
      {SUPPORT_ODOO_URL: 'https://staging.incutec.eu'},
      {email: 'a@example.com'},
    );
    assert.deepEqual(tickets, []);
    assert.equal(calls, 0);
  });

  it('maps the wire shape (snake_case) to the camelCase summary', async () => {
    let seenBody: Record<string, unknown> = {};
    stubFetch(async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          tickets: [
            {
              thread_id: 't1',
              ticket_ref: 'SUP-00001',
              pid: '1234567890',
              subject: 'ELRS not binding',
              email: 'a@example.com',
              name: 'Jane Doe',
              opened_at: 1000,
              closed_at: null,
              last_activity_at: 2000,
              status: 'open',
              product: 'ranger-rx',
              firmware: '1.2.3',
              seen_cursor: null,
              notify_cursor: '999',
            },
          ],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    });
    const tickets = await searchOdooTickets(CONFIGURED, {
      email: 'a@example.com',
      status: 'open',
      limit: 10,
    });
    assert.deepEqual(seenBody, {
      email: 'a@example.com',
      status: 'open',
      limit: 10,
    });
    assert.deepEqual(tickets, [
      {
        tid: 't1',
        ref: 'SUP-00001',
        pid: '1234567890',
        subject: 'ELRS not binding',
        email: 'a@example.com',
        name: 'Jane Doe',
        openedAt: 1000,
        closedAt: null,
        lastActivityAt: 2000,
        status: 'open',
        product: 'ranger-rx',
        firmware: '1.2.3',
        seenCursor: undefined,
        notifyCursor: '999',
      },
    ]);
  });

  it('falls back to ticket_ref for pid when the bridge omits it', async () => {
    stubFetch(async () =>
      new Response(
        JSON.stringify({
          tickets: [
            {
              thread_id: 't1',
              ticket_ref: 'SUP-00001',
              subject: 's',
              email: 'a@example.com',
              name: 'A',
              opened_at: 1000,
              closed_at: null,
              last_activity_at: null,
              status: 'open',
            },
          ],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      ),
    );
    const [ticket] = await searchOdooTickets(CONFIGURED, {email: 'a@example.com'});
    assert.equal(ticket.pid, 'SUP-00001');
    assert.equal(ticket.lastActivityAt, 1000); // falls back to openedAt
  });

  it('an error response resolves to an empty list, not thrown', async () => {
    stubFetch(async () => new Response('unauthorized', {status: 401}));
    const tickets = await searchOdooTickets(CONFIGURED, {email: 'a@example.com'});
    assert.deepEqual(tickets, []);
  });
});
