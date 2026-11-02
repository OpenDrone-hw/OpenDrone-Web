/**
 * PICOBOOT over WebUSB for the RP2350 bootrom (BOOTSEL mode).
 *
 * Protocol: RP2350 datasheet, section "PICOBOOT interface", and pico-sdk
 * src/common/boot_picoboot_headers/include/boot/picoboot.h. Clean-room from
 * the published protocol; no picotool (BSD-3) code is copied.
 *
 * Every command is a 32-byte packet on the bulk OUT endpoint, an optional
 * data phase (IN when bit 7 of the command ID is set, otherwise OUT), then a
 * zero-length acknowledgement in the opposite direction. A failed command
 * stalls the endpoint; the status comes from a vendor control request.
 *
 * SAFETY: the write path lives in `flashImage` and runs only after the page
 * has passed fcDirectWriteGate (gates.ts): (1) the pinned release is
 * published, (2) the file SHA-256 matched,
 * (3) parsed the UF2 for the target's family and flash size, (4) found the
 * target name inside the image, (5) matched the chip package, (6) checked the
 * firmware currently on the board does not name a different board, and
 * (7) collected the user's confirmations. See design.md, section "Write path".
 * `flashImage` itself also refuses while CHIP_PACKAGE_VERIFIED or
 * PICOBOOT_WRITE_VERIFIED is false (targets.ts).
 */

import {
  FLASH_SECTOR_SIZE,
  RP2350_FLASH_BASE,
  indexOf,
  sectorsOf,
  type Uf2Image,
} from './uf2.ts';
import type {ReadResult} from './gates.ts';
import {
  CHIP_PACKAGE_VERIFIED,
  FLASHER_TARGETS,
  PICOBOOT_WRITE_VERIFIED,
  RP2350_BOOTSEL_PID,
  RPI_VID,
  policyAllows,
  type ChipPackage,
} from './targets.ts';

const PICOBOOT_MAGIC = 0x431fd10b;
const CMD = {
  EXCLUSIVE_ACCESS: 0x01,
  FLASH_ERASE: 0x03,
  READ: 0x84,
  WRITE: 0x05,
  EXIT_XIP: 0x06,
  REBOOT2: 0x0a,
  GET_INFO: 0x8b,
} as const;
const IF_RESET = 0x41;
const IF_CMD_STATUS = 0x42;
const EXCLUSIVE = 1;
const NOT_EXCLUSIVE = 0;
const GET_INFO_SYS = 1;
const SYS_INFO_CHIP_INFO = 0x01;
const SYS_INFO_FLASH_DEV_INFO = 0x08;
const REBOOT2_NORMAL = 0x0;
const VENDOR_CLASS = 0xff;

const STATUS_TEXT: Record<number, string> = {
  1: 'unknown command',
  2: 'invalid command length',
  3: 'invalid transfer length',
  4: 'invalid address',
  5: 'bad alignment',
  6: 'interleaved write',
  7: 'rebooting',
  8: 'unknown error',
  9: 'invalid state',
  10: 'not permitted (secure boot or locked flash)',
  11: 'invalid argument',
  12: 'buffer too small',
  13: 'precondition not met',
  14: 'modified data',
  15: 'invalid data',
  16: 'not found',
  17: 'unsupported modification',
};

export class PicobootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PicobootError';
  }
}

export type ChipInfo = {
  /** From SYSINFO.PACKAGE_SEL: 1 = QFN60 (RP2350A/RP2354A), 0 = QFN80 (RP2350B/RP2354B). */
  chipPackage: ChipPackage | null;
  deviceId: number | null;
  /** Flash size from FLASH_DEVINFO (CS0), or null when the OTP does not say. */
  flashBytes: number | null;
};

/** The package as a read result: null from GET_INFO means it could not be read. */
export function chipPackageResult(info: ChipInfo): ReadResult<ChipPackage> {
  return info.chipPackage
    ? {status: 'ok', value: info.chipPackage}
    : {status: 'unreadable', detail: 'the bootloader did not report CHIP_INFO'};
}

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.usb && policyAllows('usb');
}

export class Picoboot {
  private token = 1;
  readonly device: FlasherUSBDevice;
  private readonly iface: number;
  private readonly epIn: number;
  private readonly epOut: number;
  private constructor(device: FlasherUSBDevice, iface: number, epIn: number, epOut: number) {
    this.device = device;
    this.iface = iface;
    this.epIn = epIn;
    this.epOut = epOut;
  }

  /** Ask the user to pick an RP2350 in BOOTSEL. Must run inside a click handler. */
  static async request(): Promise<Picoboot> {
    const usb = navigator.usb;
    if (!usb) throw new PicobootError('This browser has no WebUSB.');
    const device = await usb.requestDevice({filters: [{vendorId: RPI_VID, productId: RP2350_BOOTSEL_PID}]});
    return Picoboot.open(device);
  }

  static async open(device: FlasherUSBDevice): Promise<Picoboot> {
    if (device.vendorId !== RPI_VID || device.productId !== RP2350_BOOTSEL_PID) {
      throw new PicobootError('That device is not an RP2350 in bootloader mode.');
    }
    try {
      await device.open();
    } catch (e) {
      throw new PicobootError(
        `Could not open the board (${(e as Error).message}). On Windows this usually means the WinUSB driver is not bound to the bootloader's PICOBOOT interface; use the download method instead.`,
      );
    }
    if (!device.configuration) await device.selectConfiguration(1);
    const iface = device.configuration?.interfaces.find(
      (i) => i.alternate.interfaceClass === VENDOR_CLASS && i.alternate.endpoints.length === 2,
    );
    const epIn = iface?.alternate.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
    const epOut = iface?.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    if (!iface || !epIn || !epOut) {
      await device.close().catch(() => {});
      throw new PicobootError('PICOBOOT interface not found (the bootloader may have it disabled in OTP).');
    }
    await device.claimInterface(iface.interfaceNumber);
    const pb = new Picoboot(device, iface.interfaceNumber, epIn.endpointNumber, epOut.endpointNumber);
    await pb.resetInterface();
    return pb;
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.iface);
    } catch {
      /* already gone */
    }
    await this.device.close().catch(() => {});
  }

  private async resetInterface(): Promise<void> {
    await this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'interface',
      request: IF_RESET,
      value: 0,
      index: this.iface,
    });
  }

  private async commandStatus(): Promise<{code: number; inProgress: boolean} | null> {
    try {
      const r = await this.device.controlTransferIn(
        {requestType: 'vendor', recipient: 'interface', request: IF_CMD_STATUS, value: 0, index: this.iface},
        16,
      );
      if (!r.data || r.data.byteLength < 10) return null;
      return {code: r.data.getUint32(4, true), inProgress: r.data.getUint8(9) !== 0};
    } catch {
      return null;
    }
  }

  private async fail(what: string): Promise<never> {
    const st = await this.commandStatus();
    await this.device.clearHalt('in', this.epIn).catch(() => {});
    await this.device.clearHalt('out', this.epOut).catch(() => {});
    await this.resetInterface().catch(() => {});
    const detail = st ? STATUS_TEXT[st.code] ?? `status ${st.code}` : 'no status';
    throw new PicobootError(`${what} failed: ${detail}.`);
  }

  /** Run one command. `out` is the OUT data phase; `inLength` the IN data phase. */
  private async cmd(id: number, args: Uint8Array, opts: {out?: Uint8Array; inLength?: number} = {}): Promise<Uint8Array> {
    const isIn = (id & 0x80) !== 0;
    const transferLength = isIn ? opts.inLength ?? 0 : opts.out?.length ?? 0;
    const packet = new Uint8Array(new ArrayBuffer(32));
    const v = new DataView(packet.buffer);
    v.setUint32(0, PICOBOOT_MAGIC, true);
    v.setUint32(4, this.token++, true);
    v.setUint8(8, id);
    v.setUint8(9, args.length);
    v.setUint32(12, transferLength, true);
    packet.set(args, 16);
    const label = `Command 0x${id.toString(16)}`;

    const sent = await this.device.transferOut(this.epOut, packet);
    if (sent.status !== 'ok') return this.fail(label);
    let result: Uint8Array = new Uint8Array(0);
    if (transferLength) {
      if (isIn) {
        const r = await this.device.transferIn(this.epIn, transferLength);
        if (r.status !== 'ok' || !r.data || r.data.byteLength !== transferLength) return this.fail(label);
        result = new Uint8Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength));
      } else if (opts.out) {
        const data = new Uint8Array(new ArrayBuffer(opts.out.length));
        data.set(opts.out);
        const w = await this.device.transferOut(this.epOut, data);
        if (w.status !== 'ok' || w.bytesWritten !== transferLength) return this.fail(label);
      }
    }
    // Acknowledgement: zero-length packet in the opposite direction.
    if (isIn) {
      const ack = await this.device.transferOut(this.epOut, new Uint8Array(new ArrayBuffer(0)));
      if (ack.status !== 'ok') return this.fail(label);
    } else {
      const ack = await this.device.transferIn(this.epIn, 1);
      if (ack.status !== 'ok') return this.fail(label);
    }
    return result;
  }

  private static range(addr: number, size: number): Uint8Array {
    const a = new Uint8Array(8);
    const v = new DataView(a.buffer);
    v.setUint32(0, addr, true);
    v.setUint32(4, size, true);
    return a;
  }

  async exclusive(on: boolean): Promise<void> {
    await this.cmd(CMD.EXCLUSIVE_ACCESS, Uint8Array.of(on ? EXCLUSIVE : NOT_EXCLUSIVE));
  }

  async chipInfo(): Promise<ChipInfo> {
    const args = new Uint8Array(16);
    const v = new DataView(args.buffer);
    v.setUint8(0, GET_INFO_SYS);
    v.setUint32(4, SYS_INFO_CHIP_INFO | SYS_INFO_FLASH_DEV_INFO, true);
    const raw = await this.cmd(CMD.GET_INFO, args, {inLength: 256});
    const d = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    // Word 0: words returned; word 1: flags actually included; then fields in flag-bit order.
    const included = d.getUint32(4, true);
    let off = 8;
    let chipPackage: ChipPackage | null = null;
    let deviceId: number | null = null;
    let flashBytes: number | null = null;
    if (included & SYS_INFO_CHIP_INFO) {
      const packageSel = d.getUint32(off, true);
      deviceId = d.getUint32(off + 4, true);
      chipPackage = packageSel & 1 ? 'QFN60' : 'QFN80';
      off += 12;
    }
    if (included & SYS_INFO_FLASH_DEV_INFO) {
      const devinfo = d.getUint32(off, true);
      const cs0 = (devinfo >> 8) & 0xf;
      flashBytes = cs0 ? 4096 << cs0 : null;
    }
    return {chipPackage, deviceId, flashBytes};
  }

  /** Leave XIP so flash access goes to the device, as picotool does before any flash access. */
  async exitXip(): Promise<void> {
    await this.cmd(CMD.EXIT_XIP, new Uint8Array(0));
  }

  async read(addr: number, size: number): Promise<Uint8Array> {
    return this.cmd(CMD.READ, Picoboot.range(addr, size), {inLength: size});
  }

  private async eraseSector(addr: number): Promise<void> {
    await this.cmd(CMD.FLASH_ERASE, Picoboot.range(addr, FLASH_SECTOR_SIZE));
  }

  private async writeSector(addr: number, data: Uint8Array): Promise<void> {
    await this.cmd(CMD.WRITE, Picoboot.range(addr, data.length), {out: data});
  }

  private async rebootNormal(delayMs: number): Promise<void> {
    const args = new Uint8Array(16);
    const v = new DataView(args.buffer);
    v.setUint32(0, REBOOT2_NORMAL, true);
    v.setUint32(4, delayMs, true);
    await this.cmd(CMD.REBOOT2, args);
  }

  /**
   * Scan the firmware currently on the board for any known OpenDrone target
   * name. Read-only. Returns the names found (normally zero or one).
   */
  async findInstalledTargets(start: number, end: number, onProgress?: (done: number, total: number) => void): Promise<string[]> {
    const needles = FLASHER_TARGETS.map((t) => ({name: t.target, bytes: new TextEncoder().encode(t.target)}));
    const longest = Math.max(...needles.map((n) => n.bytes.length));
    const found = new Set<string>();
    let carry = new Uint8Array(0);
    const total = end - start;
    for (let addr = start; addr < end; addr += FLASH_SECTOR_SIZE) {
      const chunk = await this.read(addr, Math.min(FLASH_SECTOR_SIZE, end - addr));
      const hay = new Uint8Array(carry.length + chunk.length);
      hay.set(carry);
      hay.set(chunk, carry.length);
      for (const n of needles) if (indexOf(hay, n.bytes) >= 0) found.add(n.name);
      carry = hay.slice(Math.max(0, hay.length - longest + 1));
      onProgress?.(addr + chunk.length - start, total);
    }
    return [...found];
  }

  /**
   * Write a validated image. Order makes an interruption safe:
   *   1. take exclusive access (the mass-storage drive goes read-only);
   *   2. erase the boot sector FIRST, so the old image can no longer boot;
   *   3. erase + write + read-back-verify every other sector;
   *   4. write + verify the boot sector LAST;
   *   5. reboot.
   * If anything fails or the cable is pulled before step 4 completes, the
   * boot sector is blank, the bootrom finds no image, and the board comes up
   * in BOOTSEL again on its own. Retrying is always safe.
   */
  async flashImage(
    image: Uf2Image,
    onProgress: (phase: FlashPhase, done: number, total: number) => void,
  ): Promise<void> {
    if (!CHIP_PACKAGE_VERIFIED || !PICOBOOT_WRITE_VERIFIED) {
      throw new PicobootError('Direct install is disabled until it is verified on hardware. Use the copy method.');
    }
    if (image.start !== RP2350_FLASH_BASE) {
      throw new PicobootError('Image does not start at the beginning of flash; refusing to write.');
    }
    const sectors = sectorsOf(image);
    const bootAddr = RP2350_FLASH_BASE;
    const boot = sectors.get(bootAddr);
    if (!boot) throw new PicobootError('Image has no boot sector; refusing to write.');
    const rest = [...sectors.entries()].filter(([a]) => a !== bootAddr).sort((a, b) => a[0] - b[0]);
    const total = sectors.size;

    await this.exclusive(true);
    try {
      await this.exitXip();
      onProgress('erase-boot', 0, total);
      await this.eraseSector(bootAddr);

      let done = 0;
      for (const [addr, data] of rest) {
        await this.eraseSector(addr);
        await this.writeSector(addr, data);
        await this.verifySector(addr, data);
        done++;
        onProgress('write', done, total);
      }
      onProgress('write-boot', done, total);
      await this.writeSector(bootAddr, boot);
      await this.verifySector(bootAddr, boot);
      done++;
      onProgress('reboot', done, total);
    } finally {
      // Never leave the mass-storage drive locked, success or not.
      await this.exclusive(false).catch(() => {});
    }
    await this.rebootNormal(500);
  }

  private async verifySector(addr: number, expected: Uint8Array): Promise<void> {
    const got = await this.read(addr, expected.length);
    for (let i = 0; i < expected.length; i++) {
      if (got[i] !== expected[i]) {
        throw new PicobootError(`Verification failed at 0x${(addr + i).toString(16)}.`);
      }
    }
  }
}

export type FlashPhase = 'erase-boot' | 'write' | 'write-boot' | 'reboot';
