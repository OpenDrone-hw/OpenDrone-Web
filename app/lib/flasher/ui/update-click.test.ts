import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DONE_TEXT, NEED_USB_TEXT, type FlowDeps} from '../fc-update.ts';
import {finishAnnouncement, updateClick} from './update-click.ts';

function fakeDeps() {
  const calls = {openSerial: 0};
  const deps = {
    gatesOn: () => true,
    openSerial: () => {
      calls.openSerial++;
      return Promise.reject(new Error('no port picked'));
    },
    prepare: () => Promise.reject(new Error('unused')),
    findBootsel: () => Promise.resolve(null),
    openPicoboot: () => Promise.reject(new Error('unused')),
    onStage: () => {},
  } as unknown as FlowDeps;
  return {deps, calls};
}
const base = {locked: false, backedUp: true, lockText: null, backupReason: 'Confirm your config backup first.'};

test('a locked Update click announces the reason and never opens the serial picker', async () => {
  const {deps, calls} = fakeDeps();
  const said: string[] = [];
  assert.equal(updateClick({...base, locked: true, lockText: "This browser can't reach USB. Use Other ways."}, (t) => said.push(t), deps), null);
  assert.equal(updateClick({...base, locked: true, backedUp: false}, (t) => said.push(t), deps), null, 'busy: no text, still no start');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.openSerial, 0);
  assert.deepEqual(said, ["This browser can't reach USB. Use Other ways."]);
});

test('an unticked backup box announces why and never opens the serial picker', async () => {
  const {deps, calls} = fakeDeps();
  const said: string[] = [];
  assert.equal(updateClick({...base, backedUp: false}, (t) => said.push(t), deps), null);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.openSerial, 0);
  assert.deepEqual(said, ['Confirm your config backup first.']);
});

test('an allowed click opens the serial picker synchronously (user activation kept)', async () => {
  const {deps, calls} = fakeDeps();
  const flow = updateClick(base, () => {}, deps);
  assert.equal(calls.openSerial, 1, 'called before the click handler returns, no await before it');
  const r = await flow;
  assert.equal(r?.kind, 'failed');
});

test('a failure or refusal is announced once (by its role="alert" box), never also through say()', () => {
  assert.equal(finishAnnouncement({kind: 'failed', stage: 'serial', text: 'x', board: null, prepared: null}), null);
  assert.equal(finishAnnouncement({kind: 'refused', text: 'x'}), null);
  assert.equal(finishAnnouncement({kind: 'done'} as never), DONE_TEXT);
  assert.equal(finishAnnouncement({kind: 'need-usb', board: null, prepared: null} as never), NEED_USB_TEXT);
});
