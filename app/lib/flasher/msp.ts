/**
 * Minimal Betaflight MSP v1 over Web Serial: identify a running OpenFC, ask
 * it to reboot into the RP2350 ROM bootloader (BOOTSEL), or switch its USB
 * port into ESC passthrough (4-way interface) for the AM32 flasher.
 *
 * Clean-room from the MSP message layout (Betaflight src/main/msp/msp.c and
 * msp_protocol.h describe the wire format; no Betaflight app code is copied).
 * Nothing here writes FC flash or settings. MSP_SET_REBOOT only restarts the
 * board; Betaflight settings stay in flash. MSP_SET_PASSTHROUGH only bridges
 * the port to the ESCs; the next reboot or cmd_InterfaceExit ends it.
 */

import {SerialLink, type ByteLink} from './serial-link.ts';
import {policyAllows} from './targets.ts';

export const MSP = {
  API_VERSION: 1,
  FC_VARIANT: 2,
  FC_VERSION: 3,
  BOARD_INFO: 4,
  SET_REBOOT: 68,
  SET_PASSTHROUGH: 245,
} as const;

/** MSP_SET_REBOOT types (msp.c): 1 = ROM bootloader, which on RP2350 is BOOTSEL. */
const REBOOT_BOOTLOADER_ROM = 1;

export type BoardInfo = {
  fcVariant: string;
  fcVersion: string;
  apiVersion: string;
  boardIdentifier: string;
  targetName: string;
  boardName: string;
  manufacturerId: string;
};

export class MspError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MspError';
  }
}

export function isWebSerialAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.serial && policyAllows('serial');
}

export function encodeMspV1(cmd: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
  if (payload.length > 255) throw new MspError('MSP v1 payload too long.');
  const out = new Uint8Array(new ArrayBuffer(6 + payload.length));
  out.set([0x24, 0x4d, 0x3c, payload.length, cmd]);
  out.set(payload, 5);
  let ck = payload.length ^ cmd;
  for (const b of payload) ck ^= b;
  out[5 + payload.length] = ck;
  return out;
}

/**
 * Find one complete MSP v1 response for `cmd` in `buf`.
 * Returns the payload and how many bytes were consumed, or null if incomplete.
 */
export function decodeMspV1(buf: Uint8Array, cmd: number): {payload: Uint8Array; consumed: number} | null {
  for (let i = 0; i + 6 <= buf.length; i++) {
    if (buf[i] !== 0x24 || buf[i + 1] !== 0x4d) continue;
    const dir = buf[i + 2];
    if (dir !== 0x3e && dir !== 0x21) continue;
    const size = buf[i + 3] ?? 0;
    const id = buf[i + 4];
    if (i + 6 + size > buf.length) return null;
    let ck = size ^ (id ?? 0);
    for (let j = 0; j < size; j++) ck ^= buf[i + 5 + j] ?? 0;
    if (ck !== buf[i + 5 + size] || id !== cmd) continue;
    if (dir === 0x21) throw new MspError(`Flight controller rejected MSP command ${cmd}.`);
    return {payload: buf.slice(i + 5, i + 5 + size), consumed: i + 6 + size};
  }
  return null;
}

export function parseBoardInfo(p: Uint8Array): Pick<BoardInfo, 'boardIdentifier' | 'targetName' | 'boardName' | 'manufacturerId'> {
  const dec = new TextDecoder();
  let o = 0;
  const take = (n: number) => {
    if (o + n > p.length) throw new MspError('Short BOARD_INFO reply.');
    const s = p.slice(o, o + n);
    o += n;
    return s;
  };
  const boardIdentifier = dec.decode(take(4));
  take(2); // hardware revision
  take(1); // board type
  take(1); // target capabilities
  const targetName = dec.decode(take(take(1)[0] ?? 0));
  const boardName = dec.decode(take(take(1)[0] ?? 0));
  const manufacturerId = dec.decode(take(take(1)[0] ?? 0));
  return {boardIdentifier, targetName, boardName, manufacturerId};
}

/** MSP v1 decoder in the shape SerialLink.readFrame wants. */
export function mspFrame(cmd: number) {
  return (buf: Uint8Array) => {
    const hit = decodeMspV1(buf, cmd);
    return hit ? {value: hit.payload, consumed: hit.consumed} : null;
  };
}

export class MspConnection {
  readonly link: ByteLink;
  private readonly owned: SerialLink | null;
  constructor(link: ByteLink, owned: SerialLink | null = null) {
    this.link = link;
    this.owned = owned;
  }

  /** Must run inside a click handler. */
  static async request(): Promise<MspConnection> {
    const link = await SerialLink.request(115200);
    return new MspConnection(link, link);
  }

  async close(): Promise<void> {
    await this.owned?.close();
  }

  async request(cmd: number, payload?: Uint8Array, timeoutMs = 1500): Promise<Uint8Array> {
    await this.link.write(encodeMspV1(cmd, payload));
    try {
      return await this.link.readFrame(mspFrame(cmd), timeoutMs, `MSP ${cmd}`);
    } catch (e) {
      if (e instanceof MspError) throw e;
      throw new MspError('No reply from the flight controller. Is it running Betaflight?');
    }
  }

  async identify(): Promise<BoardInfo> {
    const dec = new TextDecoder();
    const api = await this.request(MSP.API_VERSION);
    const variant = await this.request(MSP.FC_VARIANT);
    const version = await this.request(MSP.FC_VERSION);
    const info = parseBoardInfo(await this.request(MSP.BOARD_INFO));
    return {
      apiVersion: `${api[1] ?? 0}.${api[2] ?? 0}`,
      fcVariant: dec.decode(variant.slice(0, 4)),
      fcVersion: `${version[0] ?? 0}.${version[1] ?? 0}.${version[2] ?? 0}`,
      ...info,
    };
  }

  /** Reboot into BOOTSEL. The port disappears; the caller closes it. */
  async rebootToBootloader(): Promise<void> {
    await this.link.write(encodeMspV1(MSP.SET_REBOOT, Uint8Array.of(REBOOT_BOOTLOADER_ROM)));
  }

  /**
   * MSP_SET_PASSTHROUGH with no payload: Betaflight replies with the number
   * of motor outputs it bridges and then speaks the 4-way interface on this
   * port until cmd_InterfaceExit. Returns the ESC count (0 = nothing to talk to).
   */
  async enterEscPassthrough(): Promise<number> {
    const reply = await this.request(MSP.SET_PASSTHROUGH);
    this.link.flush();
    return reply[0] ?? 0;
  }
}
