/**
 * AM32 on OpenESC: identify an ESC over the 4-way interface and (only when
 * every AM32_*_VERIFIED gate is true) write a verified image to it.
 *
 * Clean-room TypeScript from the protocol and layout descriptions in
 * am32-layout.ts; no esc-configurator, BLHeliSuite or Betaflight code.
 *
 * Write order (flashAm32), chosen so an interruption leaves the AM32
 * bootloader in charge rather than a half-written app:
 *   1. re-identify the ESC (MCU + name slot at 0x7BE0) and refuse on any mismatch;
 *   2. read the EEPROM/settings page as a backup for the after-check;
 *   3. erase the FIRST app page (vector table) so a partial app cannot start,
 *      and read it back: it must be all 0xFF before anything else is written;
 *   4. erase (+ blank check) + write + read-back-verify every other app page,
 *      the page holding the name slot first, so an interrupted update almost
 *      never leaves the ESC without an identity to retry against;
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
  AM32_EEPROM_OFFSET,
  AM32_EEPROM_SIZE,
  AM32_GATES,
  AM32_MCU_SIGNATURES,
  AM32_NAME_ARRAY_SIZE,
  AM32_NAME_SLOT_OFFSET,
  AM32_NAME_SLOT_SIZE,
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

/**
 * Parse the AM32 name slot (32 bytes at AM32_NAME_SLOT_OFFSET, see
 * am32-layout.ts). Strict: printable ASCII name, a NUL terminator within the
 * 30-byte `filename` array, and every byte after the name 0x00. All-0xFF or
 * all-0x00 is 'blank'; anything else malformed is 'unreadable'. The caller
 * compares the name to the target exactly, so an unknown name never matches.
 */
export function parseAm32NameSlot(slot: Uint8Array): ReadResult<string> {
  if (slot.length !== AM32_NAME_SLOT_SIZE) {
    return {status: 'unreadable', detail: `name slot read returned ${slot.length} bytes, not ${AM32_NAME_SLOT_SIZE}`};
  }
  if (slot.every((b) => b === 0xff) || slot.every((b) => b === 0x00)) {
    return {status: 'blank', detail: 'no firmware name in flash (blank or erased app)'};
  }
  const nul = slot.indexOf(0x00);
  if (nul <= 0 || nul >= AM32_NAME_ARRAY_SIZE) {
    return {status: 'unreadable', detail: 'name slot has no terminated name'};
  }
  const body = slot.subarray(0, nul);
  if (body.some((b) => b < 0x21 || b > 0x7e)) return {status: 'unreadable', detail: 'name slot bytes are not text'};
  if (slot.subarray(nul).some((b) => b !== 0x00)) {
    return {status: 'unreadable', detail: 'name slot padding is not all 0x00'};
  }
  return {status: 'ok', value: new TextDecoder().decode(body)};
}

export type EscIdentity = {
  index: number;
  deviceInfo: FourWayDeviceInfo | null;
  mcu: ReadResult<EscMcu>;
  firmwareName: ReadResult<string>;
};

/** Read-only: bootloader device info + flash name slot of ESC `index`. Never throws for a bad read. */
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
    firmwareName = parseAm32NameSlot(await fw.read(AM32_NAME_SLOT_OFFSET, AM32_NAME_SLOT_SIZE));
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
 * the bootloader, in the EEPROM page or past the app area; an image whose
 * name slot (0x08007BE0, same parser as the ESC read) is not exactly the
 * target's name; an image that also carries another ESC's name anywhere.
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
  const slotAbs = AT32F421_FLASH_BASE + AM32_NAME_SLOT_OFFSET;
  const slot = parseAm32NameSlot(hexSlice(hex, slotAbs, slotAbs + AM32_NAME_SLOT_SIZE));
  if (slot.status !== 'ok' || slot.value !== target.firmwareName) {
    const found = slot.status === 'ok' ? `"${slot.value}"` : `${slot.status} (${slot.detail})`;
    throw new Am32Error(
      `The file's firmware name at 0x${slotAbs.toString(16)} is ${found}, not ${target.firmwareName}; it is not for this ESC.`,
    );
  }
  const names = knownEscNamesIn((n) => hexContainsAscii(hex, n));
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

  const [firstPage, ...others] = image.pages;
  if (!firstPage || firstPage.offset !== AM32_APP_START) throw new Am32Error('Image has no first app page.');
  // The page holding the name slot goes first, so the identity is rewritten right away.
  const slotPage = AM32_NAME_SLOT_OFFSET - (AM32_NAME_SLOT_OFFSET % AM32_PAGE_SIZE);
  const rest = [...others.filter((p) => p.offset === slotPage), ...others.filter((p) => p.offset !== slotPage)];
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

