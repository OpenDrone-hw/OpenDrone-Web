/**
 * AM32 on OpenESC: identify an ESC over the 4-way interface and (only when
 * every AM32_*_VERIFIED gate is true) write a verified image to it.
 *
 * Clean-room TypeScript from the protocol and layout descriptions in
 * am32-layout.ts; no esc-configurator, BLHeliSuite or Betaflight code.
 *
 * Write order (flashAm32), chosen so an interruption leaves the AM32
 * bootloader in charge rather than a half-written app:
 *   1. re-identify the ESC (MCU + firmware name) and refuse on any mismatch;
 *   2. read the EEPROM/settings page as a backup for the after-check;
 *   3. erase the FIRST app page (vector table) so a partial app cannot start,
 *      and read it back: it must be all 0xFF before anything else is written;
 *   4. erase (+ blank check) + write + read-back-verify every other app page;
 *   5. write + verify the first app page LAST;
 *   6. read the EEPROM page again and require it unchanged; reset the ESC.
 * Every erase/write offset goes through assertAm32Writable, so the
 * bootloader and the EEPROM page cannot be touched. The shipped
 * AM32_*_VERIFIED constants are hard-checked here AND inside
 * FourWay.pageEraseUnchecked/writeUnchecked (F1); the `gates` argument of
 * flashAm32 only feeds the reason text and can never unlock a write.
 */

import {
  AM32_APP_START,
  AM32_EEPROM_NAME_INDEX,
  AM32_EEPROM_NAME_LENGTH,
  AM32_EEPROM_OFFSET,
  AM32_EEPROM_SIZE,
  AM32_GATES,
  AM32_MCU_SIGNATURES,
  AM32_PAGE_SIZE,
  AT32F421_FLASH_BASE,
  FOURWAY_MAX_CHUNK,
  FOURWAY_MODE_ARM_BLB,
  assertAm32WritesEnabled,
  assertAm32Writable,
  type Am32Gates,
} from './am32-layout.ts';
import type {FourWay, FourWayDeviceInfo} from './fourway.ts';
import {escDirectWriteGate, knownEscNamesIn, type ReadResult} from './gates.ts';
import {hexContainsAscii, hexSlice, parseIntelHex} from './intel-hex.ts';
import type {FirmwareRelease} from './manifest.ts';
import type {EscMcu, EscTarget} from './targets.ts';

export class Am32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Am32Error';
  }
}

/** MCU from the bootloader's device info. Unknown signatures and non-ARM bootloaders are not 'ok'. */
export function classifyMcu(info: FourWayDeviceInfo): ReadResult<EscMcu> {
  const sig = `0x${info.signature.toString(16).padStart(4, '0')}`;
  if (info.interfaceMode !== FOURWAY_MODE_ARM_BLB) {
    return {status: 'unknown', detail: `bootloader mode ${info.interfaceMode} is not an AM32 (ARM) bootloader`};
  }
  if (info.signature === 0 || info.signature === 0xffff) return {status: 'unreadable', detail: `signature ${sig}`};
  const mcu = AM32_MCU_SIGNATURES[info.signature];
  if (!mcu) return {status: 'unknown', detail: `signature ${sig} is not a known chip`};
  return {status: 'ok', value: mcu as EscMcu};
}

/** Firmware name from the AM32 EEPROM page bytes (at least NAME_INDEX + NAME_LENGTH long). */
export function parseEepromFirmwareName(eeprom: Uint8Array): ReadResult<string> {
  if (eeprom.length < AM32_EEPROM_NAME_INDEX + AM32_EEPROM_NAME_LENGTH) {
    return {status: 'unreadable', detail: 'short EEPROM read'};
  }
  const raw = eeprom.subarray(AM32_EEPROM_NAME_INDEX, AM32_EEPROM_NAME_INDEX + AM32_EEPROM_NAME_LENGTH);
  if (raw.every((b) => b === 0xff) || raw.every((b) => b === 0x00)) {
    return {status: 'blank', detail: 'no firmware name stored (blank or erased EEPROM)'};
  }
  // Printable ASCII, optionally space/NUL padded at the end. Anything else is not an AM32 name.
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0x20 || raw[end - 1] === 0x00)) end--;
  const body = raw.subarray(0, end);
  if (!body.length || body.some((b) => b < 0x20 || b > 0x7e)) {
    return {status: 'unreadable', detail: 'EEPROM name bytes are not text'};
  }
  return {status: 'ok', value: new TextDecoder().decode(body)};
}

export type EscIdentity = {
  index: number;
  deviceInfo: FourWayDeviceInfo | null;
  mcu: ReadResult<EscMcu>;
  firmwareName: ReadResult<string>;
};

/** Read-only: bootloader device info + EEPROM firmware name of ESC `index`. Never throws for a bad read. */
export async function identifyEsc(fw: FourWay, index: number): Promise<EscIdentity> {
  let deviceInfo: FourWayDeviceInfo | null = null;
  let mcu: ReadResult<EscMcu>;
  try {
    await fw.resync();
    deviceInfo = await fw.initFlash(index);
    mcu = classifyMcu(deviceInfo);
  } catch (e) {
    const detail = (e as Error).message;
    return {
      index,
      deviceInfo: null,
      mcu: {status: 'unreadable', detail},
      firmwareName: {status: 'unreadable', detail: 'bootloader did not answer'},
    };
  }
  let firmwareName: ReadResult<string>;
  try {
    firmwareName = parseEepromFirmwareName(
      await fw.read(AM32_EEPROM_OFFSET, AM32_EEPROM_NAME_INDEX + AM32_EEPROM_NAME_LENGTH),
    );
  } catch (e) {
    firmwareName = {status: 'unreadable', detail: (e as Error).message};
  }
  return {index, deviceInfo, mcu, firmwareName};
}

export type Am32Page = {offset: number; data: Uint8Array};

export type Am32Image = {
  target: string;
  /** App pages to write, ascending, each AM32_PAGE_SIZE bytes, 0xFF filled. */
  pages: Am32Page[];
  start: number;
  end: number;
};

/**
 * Parse and check a verified AM32 .hex for one ESC target. Rejects: data in
 * the bootloader, in the EEPROM page or past the app area; an image that does
 * not carry the target's firmware name or carries another ESC's name.
 */
export function prepareAm32Image(hexText: string, target: EscTarget): Am32Image {
  const hex = parseIntelHex(hexText);
  const start = hex.start - AT32F421_FLASH_BASE;
  const end = hex.end - AT32F421_FLASH_BASE;
  if (hex.start < AT32F421_FLASH_BASE) throw new Am32Error('The file has data below ESC flash.');
  assertAm32Writable(start, end - start);
  // F9: AM32 builds start exactly at the app address. Anything else would be
  // padded with 0xFF and could write 0xFFFFFFFF as the initial stack pointer.
  if (start !== AM32_APP_START) {
    throw new Am32Error(`The image must start at the AM32 app address 0x${(AT32F421_FLASH_BASE + AM32_APP_START).toString(16)}.`);
  }
  const names = knownEscNamesIn((n) => hexContainsAscii(hex, n));
  if (!names.includes(target.firmwareName)) {
    throw new Am32Error(`The file does not contain the firmware name ${target.firmwareName}; it is not for this ESC.`);
  }
  const others = names.filter((n) => n !== target.firmwareName);
  if (others.length) throw new Am32Error(`The file also names ${others.join(', ')}; refusing an ambiguous image.`);
  // F9: every page from the app start to the image end is erased and written,
  // including pages with no data (written as 0xFF), so no old code survives in a hole.
  const pages: Am32Page[] = [];
  for (let off = AM32_APP_START; off < end; off += AM32_PAGE_SIZE) {
    assertAm32Writable(off, AM32_PAGE_SIZE);
    const abs = AT32F421_FLASH_BASE + off;
    pages.push({offset: off, data: hexSlice(hex, abs, abs + AM32_PAGE_SIZE)});
  }
  if (!pages.length || pages[0]?.offset !== AM32_APP_START) {
    throw new Am32Error(`The image must start at the AM32 app address 0x${(AT32F421_FLASH_BASE + AM32_APP_START).toString(16)}.`);
  }
  return {target: target.target, pages, start, end};
}

export type Am32Phase = 'identify' | 'backup' | 'erase-first' | 'write' | 'write-first' | 'check-eeprom' | 'reset';

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Write a prepared image to ESC `index`. Re-runs the full gate right before
 * writing (gates, published release, MCU + firmware name read now) and
 * throws if anything does not hold. With the shipped AM32_*_VERIFIED=false
 * flags this always throws before touching flash, whatever `gates` says:
 * `gates` only shapes the reason text (F1).
 */
export async function flashAm32(
  fw: FourWay,
  index: number,
  image: Am32Image,
  target: EscTarget,
  release: FirmwareRelease,
  onProgress: (phase: Am32Phase, done: number, total: number) => void,
  gates: Am32Gates = AM32_GATES,
): Promise<void> {
  assertAm32WritesEnabled();
  const total = image.pages.length;
  onProgress('identify', 0, total);
  if (image.target !== target.target) throw new Am32Error('The prepared image is for another ESC.');
  const id = await identifyEsc(fw, index);
  const gate = escDirectWriteGate({
    gates,
    chosen: target,
    release,
    verifiedFor: image.target,
    mcu: id.mcu,
    firmwareName: id.firmwareName,
  });
  if (!gate.allowed) throw new Am32Error(`Not writing: ${gate.reasons.join(' ')}`);
  for (const p of image.pages) assertAm32Writable(p.offset, p.data.length);

  onProgress('backup', 0, total);
  const eepromBefore = await fw.readRange(AM32_EEPROM_OFFSET, AM32_EEPROM_SIZE);

  const [firstPage, ...rest] = image.pages;
  if (!firstPage || firstPage.offset !== AM32_APP_START) throw new Am32Error('Image has no first app page.');
  onProgress('erase-first', 0, total);
  await erasePage(fw, firstPage.offset);

  let done = 0;
  for (const p of rest) {
    await erasePage(fw, p.offset);
    await writeAndVerify(fw, p);
    onProgress('write', ++done, total);
  }
  onProgress('write-first', done, total);
  await writeAndVerify(fw, firstPage);
  onProgress('check-eeprom', ++done, total);
  const eepromAfter = await fw.readRange(AM32_EEPROM_OFFSET, AM32_EEPROM_SIZE);
  if (!equal(eepromBefore, eepromAfter)) {
    throw new Am32Error('The ESC settings page changed during the update. Check the ESC settings in esc-configurator.');
  }
  onProgress('reset', done, total);
  await fw.resetEsc(index);
}

/**
 * Erase one app page and read it back (F4): the page must be all 0xFF before
 * anything else happens. A bootloader that ACKs the erase without doing it
 * (or erases another page) stops the update here, with the old vector table
 * still intact, instead of producing a hybrid image.
 */
async function erasePage(fw: FourWay, offset: number): Promise<void> {
  assertAm32Writable(offset, AM32_PAGE_SIZE);
  if (offset % AM32_PAGE_SIZE) throw new Am32Error('Unaligned page erase.');
  await fw.pageEraseUnchecked(offset / AM32_PAGE_SIZE);
  const back = await fw.readRange(offset, AM32_PAGE_SIZE);
  const bad = back.findIndex((b) => b !== 0xff);
  if (bad >= 0) {
    throw new Am32Error(
      `The ESC did not erase the page at 0x${(AT32F421_FLASH_BASE + offset).toString(16)} (byte 0x${(AT32F421_FLASH_BASE + offset + bad).toString(16)} is not blank). Stopped before writing.`,
    );
  }
}

async function writeAndVerify(fw: FourWay, page: Am32Page): Promise<void> {
  for (let o = 0; o < page.data.length; o += FOURWAY_MAX_CHUNK) {
    const chunk = page.data.subarray(o, o + FOURWAY_MAX_CHUNK);
    assertAm32Writable(page.offset + o, chunk.length);
    await fw.writeUnchecked(page.offset + o, chunk);
  }
  const back = await fw.readRange(page.offset, page.data.length);
  if (!equal(back, page.data)) {
    throw new Am32Error(`Read-back mismatch in the page at 0x${(AT32F421_FLASH_BASE + page.offset).toString(16)}.`);
  }
}

