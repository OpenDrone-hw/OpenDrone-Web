import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {fcDeviceBusy, serialButtonState, USB_HOLD_REASON, usbDisconnectDropsConnection} from './device-hold.ts';
import {MspConnection, MspError} from './msp.ts';
import {SerialLinkError, type ByteLink, type Decoded} from './serial-link.ts';

/** A fake FC serial port: answers "#\r\n" with a prompt and "bl rom\r\n" with "Rebooting", silence, or a vanished port. */
class FakeFc implements ByteLink {
  writes: number[][] = [];
  private buf: number[] = [];
  private closed = false;
  private opts: {prompt?: string | null; blRom?: 'rebooting' | 'silent' | 'vanish'};
  constructor(opts: {prompt?: string | null; blRom?: 'rebooting' | 'silent' | 'vanish'} = {}) {
    this.opts = opts;
  }
  async write(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.writes.push([...bytes]);
    const s = String.fromCharCode(...bytes);
    const push = (t: string) => this.buf.push(...Array.from(t, (c) => c.charCodeAt(0)));
    if (s === '#\r\n' && this.opts.prompt !== null) push(this.opts.prompt ?? "\r\nEntering CLI Mode, type 'exit' to return, or 'help'\r\n\r\n# ");
    if (s === 'bl rom\r\n') {
      const mode = this.opts.blRom ?? 'rebooting';
      if (mode === 'rebooting') push('bl rom\r\n\r\nrestarting in ROM bootloader mode\r\nRebooting');
      if (mode === 'vanish') this.closed = true;
    }
  }
  async readFrame<T>(decode: (buf: Uint8Array) => Decoded<T>, _t: number, what: string): Promise<T> {
    const hit = decode(Uint8Array.from(this.buf));
    if (hit) {
      this.buf = this.buf.slice(hit.consumed);
      return hit.value;
    }
    if (this.closed) throw new SerialLinkError('Serial port closed.');
    throw new SerialLinkError(`No reply (${what}).`);
  }
  flush(): void {
    this.buf = [];
  }
}

const hex = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe('A2: restart into the ROM bootloader through the Betaflight CLI', () => {
  it('sends exactly 23 0D 0A, then after the prompt 62 6C 20 72 6F 6D 0D 0A, and resolves on "Rebooting"', async () => {
    const fc = new FakeFc();
    await new MspConnection(fc).rebootToBootloader();
    assert.deepEqual(fc.writes, [
      [0x23, 0x0d, 0x0a],
      [0x62, 0x6c, 0x20, 0x72, 0x6f, 0x6d, 0x0d, 0x0a],
    ]);
    assert.deepEqual(fc.writes[1], hex('bl rom\r\n'));
  });
  it('no CLI prompt: a visible error and "bl rom" is never sent', async () => {
    const fc = new FakeFc({prompt: null});
    await assert.rejects(new MspConnection(fc).rebootToBootloader(), (e: unknown) => e instanceof MspError && /no "#" prompt/.test(e.message));
    assert.deepEqual(fc.writes, [[0x23, 0x0d, 0x0a]]);
  });
  it('the port vanishing after "bl rom" counts as success', async () => {
    const fc = new FakeFc({blRom: 'vanish'});
    await new MspConnection(fc).rebootToBootloader();
    assert.equal(fc.writes.length, 2);
  });
  it('no confirmation and the port still open after "bl rom": a visible error', async () => {
    await assert.rejects(new MspConnection(new FakeFc({blRom: 'silent'})).rebootToBootloader(), /did not confirm "bl rom"/);
  });
});

describe('A: a stale USB connection never silently disables the serial buttons', () => {
  const dev = {name: 'RP2350 Boot'};
  it('busy while the USB panel is connected, connecting or writing; free otherwise', () => {
    assert.equal(fcDeviceBusy({connected: false, connecting: false, flashing: false}), false);
    for (const k of ['connected', 'connecting', 'flashing'] as const) {
      assert.equal(fcDeviceBusy({connected: false, connecting: false, flashing: false, [k]: true}), true, k);
    }
  });
  it('a USB disconnect of the held device drops the connection, so busy clears', () => {
    assert.equal(usbDisconnectDropsConnection(dev, dev, false), true);
    // after the drop the panel reports connected=false -> not busy -> buttons enabled
    assert.equal(fcDeviceBusy({connected: false, connecting: false, flashing: false}), false);
    assert.deepEqual(serialButtonState({usbHolds: false}), {disabled: false, reason: null});
  });
  it('ignores other devices, no connection, and a disconnect during a write (the write path reports it)', () => {
    assert.equal(usbDisconnectDropsConnection(dev, {name: 'other'}, false), false);
    assert.equal(usbDisconnectDropsConnection(null, dev, false), false);
    assert.equal(usbDisconnectDropsConnection(dev, undefined, false), false);
    assert.equal(usbDisconnectDropsConnection(dev, dev, true), false);
  });
  it('while the USB panel holds the board, the serial buttons are disabled WITH a visible reason', () => {
    const s = serialButtonState({usbHolds: true});
    assert.equal(s.disabled, true);
    assert.equal(s.reason, USB_HOLD_REASON);
    assert.ok(s.reason.length > 10);
  });
});
