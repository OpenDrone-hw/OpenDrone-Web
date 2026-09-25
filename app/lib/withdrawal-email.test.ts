import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {sendWithdrawalNotice, type WithdrawalNotice} from './withdrawal-email.ts';

const NOTICE: WithdrawalNotice = {
  name: 'A Buyer',
  email: 'buyer@example.com',
  orderNumber: '#1001',
  products: 'OpenRX Lite',
  receivedOn: '',
  remarks: '',
  locale: 'en',
  submittedAt: '2026-09-22T10:00:00.000Z',
};
const ENV = {RESEND_API_KEY: 'key', PUBLIC_COMPANY_EMAIL: 'contact@opendrone.be'};

function recorder(statuses: number[]) {
  const sentTo: string[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    sentTo.push((JSON.parse(String(init?.body)) as {to: string[]}).to[0]);
    return new Response('{}', {status: statuses[sentTo.length - 1] ?? 200});
  }) as typeof fetch;
  return {fetcher, sentTo};
}

describe('sendWithdrawalNotice', () => {
  it('notifies the shop, then sends the receipt', async () => {
    const {fetcher, sentTo} = recorder([200, 200]);
    assert.deepEqual(await sendWithdrawalNotice(ENV, NOTICE, fetcher), {shopNotified: true, receiptSent: true});
    assert.deepEqual(sentTo, ['contact@opendrone.be', 'buyer@example.com']);
  });

  it('sends no receipt when the shop notice fails', async () => {
    const {fetcher, sentTo} = recorder([500]);
    assert.deepEqual(await sendWithdrawalNotice(ENV, NOTICE, fetcher), {shopNotified: false, receiptSent: false});
    assert.deepEqual(sentTo, ['contact@opendrone.be']);
  });

  it('reports nothing sent without a mail key', async () => {
    const {fetcher, sentTo} = recorder([]);
    assert.deepEqual(await sendWithdrawalNotice({}, NOTICE, fetcher), {shopNotified: false, receiptSent: false});
    assert.deepEqual(sentTo, []);
  });

  it('treats a network error as not sent', async () => {
    const fetcher = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    assert.deepEqual(await sendWithdrawalNotice(ENV, NOTICE, fetcher), {shopNotified: false, receiptSent: false});
  });

  it('keeps the shop result when only the receipt fails', async () => {
    const {fetcher} = recorder([200, 500]);
    assert.deepEqual(await sendWithdrawalNotice(ENV, NOTICE, fetcher), {shopNotified: true, receiptSent: false});
  });
});
