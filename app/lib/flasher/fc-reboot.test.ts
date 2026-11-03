import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {REBOOT_SENT_TEXT, rebootFcToBootsel, type RebootConnection} from './fc-reboot.ts';
import {FLASHER_TARGETS} from './targets.ts';
import type {BoardInfo} from './msp.ts';

const LITE = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_RP2350B')!;
const MINI = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_MINI_RP2350A')!;
const info = (boardName: string, manufacturerId = 'OPFC'): BoardInfo => ({
  fcVariant: 'BTFL',
  fcVersion: '2026.12.0',
  apiVersion: '1.47',
  boardIdentifier: 'RP2350',
  targetName: '',
  boardName,
  manufacturerId,
});

function fakeConn(i: BoardInfo | Error) {
  const calls: string[] = [];
  const conn: RebootConnection = {
    identify: async () => {
      calls.push('identify');
      if (i instanceof Error) throw i;
      return i;
    },
    rebootToBootloader: async () => void calls.push('reboot'),
    close: async () => void calls.push('close'),
  };
  return {conn, calls};
}

describe('step 3: restart into bootloader', () => {
  it('the click goes to Web Serial: the default path calls navigator.serial.requestPort', async () => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, 'serial');
    let requested = 0;
    Object.defineProperty(nav, 'serial', {
      configurable: true,
      value: {
        requestPort: async () => {
          requested++;
          throw new DOMException('No port selected by the user.', 'NotFoundError');
        },
      },
    });
    try {
      const r = await rebootFcToBootsel(LITE);
      assert.equal(requested, 1);
      assert.equal(r.kind, 'error');
      assert.match(r.text, /No device was selected/);
    } finally {
      if (had) Object.defineProperty(nav, 'serial', had);
      else delete nav.serial;
    }
  });
  it('sends the reboot only when the board names the chosen target, and closes the port', async () => {
    const {conn, calls} = fakeConn(info(LITE.target));
    const r = await rebootFcToBootsel(LITE, async () => conn);
    assert.deepEqual(r, {kind: 'ok', text: REBOOT_SENT_TEXT});
    assert.deepEqual(calls, ['identify', 'reboot', 'close']);
  });
  it('a Mini chosen as Lite (and the reverse) gets a visible refusal, no reboot', async () => {
    for (const [chosen, actual] of [
      [LITE, MINI],
      [MINI, LITE],
    ] as const) {
      const {conn, calls} = fakeConn(info(actual.target));
      const r = await rebootFcToBootsel(chosen, async () => conn);
      assert.equal(r.kind, 'error');
      assert.match(r.text, new RegExp(`reports ${actual.target}.*Not restarting`));
      assert.deepEqual(calls, ['identify', 'close']);
    }
  });
  it('every failure path returns visible text: no board, picker error, no MSP reply, unknown board', async () => {
    const none = await rebootFcToBootsel(null, async () => {
      throw new Error('must not open');
    });
    assert.equal(none.kind, 'error');
    assert.ok(none.text.length > 0);
    const picker = await rebootFcToBootsel(LITE, async () => {
      throw new Error('Failed to open serial port.');
    });
    assert.equal(picker.kind, 'error');
    assert.match(picker.text, /Failed to open serial port\..*hold BOOT/);
    const silent = fakeConn(new Error('No reply from the flight controller. Is it running Betaflight?'));
    const r1 = await rebootFcToBootsel(LITE, async () => silent.conn);
    assert.match(r1.text, /No reply/);
    assert.deepEqual(silent.calls, ['identify', 'close']);
    const other = fakeConn(info('SOMEBOARD', 'XXXX'));
    const r2 = await rebootFcToBootsel(LITE, async () => other.conn);
    assert.equal(r2.kind, 'error');
    assert.ok(!other.calls.includes('reboot'));
  });
});
