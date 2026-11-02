/**
 * BLHeli 4-way interface ("4way-if") client, clean-room from the protocol
 * description. No Betaflight (serial_4way.c), esc-configurator or
 * BLHeliSuite code was copied.
 *
 * Wire format:
 *   request  (host -> interface): 0x2F cmd addrHi addrLo len params[len] crcHi crcLo
 *   response (interface -> host): 0x2E cmd addrHi addrLo len params[len] ack crcHi crcLo
 * `len` 0 means 256 bytes. A request always carries at least one parameter
 * byte (a command with no parameters sends a single 0). The CRC is
 * CRC-16/XMODEM (poly 0x1021, init 0) over every byte before it.
 *
 * The interface is either Betaflight after MSP_SET_PASSTHROUGH (the FC
 * bridges its USB port to the ESC signal wires) or a stand-alone USB-serial
 * link adapter running 4way-if firmware. Same frames either way.
 */

import {
  AM32_PAGE_SIZE,
  FOURWAY_DEVICE_INFO_MODE_INDEX,
  FOURWAY_DEVICE_INFO_SIG_HI_INDEX,
  FOURWAY_DEVICE_INFO_SIG_LO_INDEX,
  FOURWAY_MAX_CHUNK,
  assertAm32WritesEnabled,
} from './am32-layout.ts';
import type {ByteLink, Decoded} from './serial-link.ts';

export const FOURWAY_CMD = {
  InterfaceTestAlive: 0x30,
  ProtocolGetVersion: 0x31,
  InterfaceGetName: 0x32,
  InterfaceGetVersion: 0x33,
  InterfaceExit: 0x34,
  DeviceReset: 0x35,
  DeviceInitFlash: 0x37,
  DeviceEraseAll: 0x38,
  DevicePageErase: 0x39,
  DeviceRead: 0x3a,
  DeviceWrite: 0x3b,
  DeviceReadEEprom: 0x3d,
  DeviceWriteEEprom: 0x3e,
  InterfaceSetMode: 0x3f,
  DeviceVerify: 0x40,
} as const;

/** 4-way ACK codes (0x01, 0x05..0x07 are reserved). */
export const ACK_TEXT: Readonly<Record<number, string>> = {
  0x00: 'OK',
  0x02: 'invalid command',
  0x03: 'CRC error',
  0x04: 'verify error',
  0x08: 'invalid ESC number',
  0x09: 'invalid parameter',
  0x0f: 'general device error',
};

const REQ_START = 0x2f;
const RESP_START = 0x2e;

export class FourWayError extends Error {
  readonly ack: number | null;
  constructor(message: string, ack: number | null = null) {
    super(message);
    this.name = 'FourWayError';
    this.ack = ack;
  }
}

export function crc16Xmodem(bytes: Uint8Array, crc = 0): number {
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function encodeFourWay(cmd: number, address: number, params: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
  if (address < 0 || address > 0xffff) throw new FourWayError(`Address 0x${address.toString(16)} does not fit 16 bits.`);
  const p = params.length ? params : Uint8Array.of(0);
  if (p.length > 256) throw new FourWayError('4-way payload longer than 256 bytes.');
  const out = new Uint8Array(new ArrayBuffer(5 + p.length + 2));
  out.set([REQ_START, cmd, (address >> 8) & 0xff, address & 0xff, p.length & 0xff]);
  out.set(p, 5);
  const crc = crc16Xmodem(out.subarray(0, 5 + p.length));
  out[5 + p.length] = crc >> 8;
  out[6 + p.length] = crc & 0xff;
  return out;
}

export type FourWayResponse = {cmd: number; address: number; params: Uint8Array; ack: number};

/**
 * Find one valid response frame for `cmd` in `buf`. Bytes before it (echo of
 * the request on a one-wire bus, noise, stale frames) are skipped. A frame
 * with a bad CRC is skipped, never accepted.
 */
export function decodeFourWay(buf: Uint8Array, cmd: number): Decoded<FourWayResponse> {
  for (let i = 0; i + 8 <= buf.length; i++) {
    if (buf[i] !== RESP_START || buf[i + 1] !== cmd) continue;
    const len = buf[i + 4] || 256;
    const total = 5 + len + 3;
    if (i + total > buf.length) return null;
    const crc = crc16Xmodem(buf.subarray(i, i + 5 + len + 1));
    const got = ((buf[i + 5 + len + 1] ?? 0) << 8) | (buf[i + 5 + len + 2] ?? 0);
    if (crc !== got) continue;
    return {
      value: {
        cmd,
        address: ((buf[i + 2] ?? 0) << 8) | (buf[i + 3] ?? 0),
        params: buf.slice(i + 5, i + 5 + len),
        ack: buf[i + 5 + len] ?? 0xff,
      },
      consumed: i + total,
    };
  }
  return null;
}

export type FourWayDeviceInfo = {
  /** 16-bit bootloader signature (identifies the MCU). */
  signature: number;
  interfaceMode: number;
  raw: Uint8Array;
};

export function parseDeviceInfo(params: Uint8Array): FourWayDeviceInfo {
  if (params.length < 4) throw new FourWayError('Short device info from the ESC bootloader.');
  const lo = params[FOURWAY_DEVICE_INFO_SIG_LO_INDEX] ?? 0;
  const hi = params[FOURWAY_DEVICE_INFO_SIG_HI_INDEX] ?? 0;
  return {
    signature: (hi << 8) | lo,
    interfaceMode: params[FOURWAY_DEVICE_INFO_MODE_INDEX] ?? 0,
    raw: params.slice(0, 4),
  };
}

export class FourWay {
  private readonly link: ByteLink;
  /**
   * F2: set after a timeout or a reply that does not belong to the request.
   * While set, every command except InterfaceTestAlive is refused, so a late
   * frame can never be taken as the answer to a later request.
   */
  private desynced = false;
  constructor(link: ByteLink) {
    this.link = link;
  }

  get isDesynced(): boolean {
    return this.desynced;
  }

  /**
   * Send one request and return its reply. The receive buffer is flushed
   * first, the reply must carry the same command, and `check` binds it to the
   * request (address, length). Any mismatch or timeout marks the link out of
   * step until testAlive() round-trips cleanly.
   */
  async command(
    cmd: number,
    address = 0,
    params?: Uint8Array,
    timeoutMs = 2000,
    check?: (r: FourWayResponse) => string | null,
  ): Promise<FourWayResponse> {
    const what = `4-way command 0x${cmd.toString(16)}`;
    if (this.desynced && cmd !== FOURWAY_CMD.InterfaceTestAlive) {
      throw new FourWayError(`ESC link is out of step after a missing or mismatched reply; not sending ${what}. Reconnect and try again.`);
    }
    this.link.flush();
    await this.link.write(encodeFourWay(cmd, address, params));
    let r: FourWayResponse;
    try {
      r = await this.link.readFrame((b) => decodeFourWay(b, cmd), timeoutMs, what);
    } catch (e) {
      this.desynced = true;
      throw e;
    }
    const problem = check?.(r) ?? null;
    if (problem) {
      this.desynced = true;
      throw new FourWayError(`Reply does not match the request (${what}): ${problem}.`);
    }
    if (r.ack !== 0) {
      throw new FourWayError(`ESC interface: ${ACK_TEXT[r.ack] ?? `error 0x${r.ack.toString(16)}`} (command 0x${cmd.toString(16)}).`, r.ack);
    }
    if (cmd === FOURWAY_CMD.InterfaceTestAlive) this.desynced = false;
    return r;
  }

  async testAlive(): Promise<void> {
    await this.command(FOURWAY_CMD.InterfaceTestAlive, 0, undefined, 2000, sameAddress(0));
  }

  /** If an earlier command timed out or mismatched, re-sync with a clean testAlive round trip. */
  async resync(): Promise<void> {
    if (this.desynced) await this.testAlive();
  }

  async protocolVersion(): Promise<number> {
    return (await this.command(FOURWAY_CMD.ProtocolGetVersion)).params[0] ?? 0;
  }

  async interfaceName(): Promise<string> {
    return new TextDecoder().decode((await this.command(FOURWAY_CMD.InterfaceGetName)).params).replace(/\0+$/, '');
  }

  /** Connect to ESC `index`'s bootloader and read its device info. Read-only. */
  async initFlash(index: number): Promise<FourWayDeviceInfo> {
    const r = await this.command(FOURWAY_CMD.DeviceInitFlash, 0, Uint8Array.of(index), 4000, (x) =>
      x.params.length === 4 ? null : `device info is ${x.params.length} bytes, expected 4`,
    );
    return parseDeviceInfo(r.params);
  }

  /** Read `length` (1..256) bytes at 4-way offset `address`. */
  async read(address: number, length: number): Promise<Uint8Array> {
    if (length < 1 || length > FOURWAY_MAX_CHUNK) throw new FourWayError('Read length must be 1..256.');
    const r = await this.command(FOURWAY_CMD.DeviceRead, address, Uint8Array.of(length & 0xff), 2000, (x) =>
      sameAddress(address)(x) ?? (x.params.length === length ? null : `${x.params.length} bytes, expected ${length}`),
    );
    return r.params;
  }

  async readRange(address: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let o = 0; o < length; o += FOURWAY_MAX_CHUNK) {
      out.set(await this.read(address + o, Math.min(FOURWAY_MAX_CHUNK, length - o)), o);
    }
    return out;
  }

  /**
   * Low-level erase/write. F1: both hard-check the shipped AM32_*_VERIFIED
   * constants themselves (assertAm32WritesEnabled), like Picoboot.flashImage,
   * so no caller can reach the ESC flash while any flag is false. Address
   * checks (assertAm32Writable) stay the caller's job; am32.ts is the only one.
   */
  async pageEraseUnchecked(page: number): Promise<void> {
    assertAm32WritesEnabled();
    // Betaflight's 4-way interface answers an ARM page erase with the page's byte address; accept that or 0.
    await this.command(FOURWAY_CMD.DevicePageErase, 0, Uint8Array.of(page & 0xff), 4000, (x) =>
      x.address === 0 || x.address === ((page * AM32_PAGE_SIZE) & 0xffff) ? null : `address 0x${x.address.toString(16)} for page ${page}`,
    );
  }

  async writeUnchecked(address: number, data: Uint8Array): Promise<void> {
    assertAm32WritesEnabled();
    if (data.length < 1 || data.length > FOURWAY_MAX_CHUNK) throw new FourWayError('Write length must be 1..256.');
    await this.command(FOURWAY_CMD.DeviceWrite, address, data, 4000, sameAddress(address));
  }

  async resetEsc(index: number): Promise<void> {
    await this.command(FOURWAY_CMD.DeviceReset, 0, Uint8Array.of(index));
  }

  /** Leave the 4-way interface; Betaflight returns to MSP. */
  async exit(): Promise<void> {
    await this.command(FOURWAY_CMD.InterfaceExit);
  }
}

function sameAddress(address: number): (r: FourWayResponse) => string | null {
  return (r) => (r.address === address ? null : `reply for 0x${r.address.toString(16)}, request was 0x${address.toString(16)}`);
}
