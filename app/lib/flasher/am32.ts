/**
 * AM32 on OpenESC: identify an ESC over the 4-way interface and (only when
 * every AM32_*_VERIFIED gate is true) write a verified image to it.
 *
 * Clean-room TypeScript from the protocol and layout descriptions in
 * am32-layout.ts; no esc-configurator, BLHeliSuite or Betaflight code.
 *
 * The flash reproduces the QC image: app + EEPROM v4 defaults (192 B at
 * 0x7C00). The bootloader is never written.
 *
 * Write order (flashAm32), chosen so an interruption leaves the AM32
 * bootloader in charge rather than a half-written app:
 *   1. re-identify the ESC (MCU + name slot at 0x7BE0) and refuse on any mismatch;
 *   2. erase the FIRST app page (vector table) so a partial app cannot start,
 *      and read it back: it must be all 0xFF before anything else is written;
 *   3. erase (+ blank check) + write + read-back-verify every other app page,
 *      the page holding the name slot first, so an interrupted update almost
 *      never leaves the ESC without an identity to retry against;
 *   4. EEPROM: erase the page at 0x7C00 (must read back all 0xFF), write the
 *      pinned 192-byte defaults, read back and compare byte for byte. It sits
 *      AFTER every other app page is verified and BEFORE the first page: until
 *      the first page is written the bootloader will not start the app, so an
 *      interruption in the EEPROM step can never leave a runnable app with a
 *      blank or half-written settings page. (Settings are lost either way;
 *      the identity needed for a retry lives in the app area, not here.)
 *   5. write + verify the first app page LAST (this is what makes the app bootable);
 *   6. F4 (review 3): read back the WHOLE image once more (every app page,
 *      name slot included, then the EEPROM page: defaults followed by 0xFF)
 *      and require it byte-identical. This catches an erase or an implicit
 *      aligned-write erase that reached a page verified earlier (2 KB erase
 *      granularity, B10/B11). On a mismatch the first app page is erased
 *      again (best effort) so the hybrid app cannot run, and the install
 *      fails with Am32FinalVerifyError; nothing says "Installed";
 *   7. reset the ESC.
 * Erase (F5, review 3): every erase is read back. If the page is not blank
 * after DevicePageErase (the AM32 bootloader may only ACK it and erase inside
 * its write path for 1 KB-aligned addresses), the fallback writes 0xFF at the
 * page start (aligned, through the same address guards and gates) and the
 * blank check runs again; still not blank = stop before writing. Programming
 * 0xFF over erased flash is a no-op, and over programmed flash it cannot set
 * bits, so the fallback can only make the check pass through a real erase.
 * Which path each page took is returned to the caller (bench record).
 * App erase/write offsets go through assertAm32Writable, so they can never
 * reach the bootloader or the EEPROM page. The EEPROM step goes only through
 * assertAm32EepromWritable / assertAm32EepromPageErasable (exactly
 * 0x7C00..0x7CBF). The AM32_*_VERIFIED flags (or the staging bench switch,
 * staging.ts) are hard-checked here AND inside
 * FourWay.pageEraseUnchecked/writeUnchecked (F1); the `gates` argument of
 * flashAm32 only feeds the reason text and can never unlock a write.
 */

import {
  AM32_APP_START,
  AM32_EEPROM_DEFAULTS_SIZE,
  AM32_EEPROM_LAYOUT_VERSION_INDEX,
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
  assertAm32EepromPageErasable,
  assertAm32EepromWritable,
  assertAm32WritesEnabled,
  assertAm32Writable,
  type Am32Gates,
} from './am32-layout.ts';
import type {FourWay, FourWayDeviceInfo} from './fourway.ts';
import {escDirectWriteGate, knownEscNamesIn, type ReadResult} from './gates.ts';
import {hexContainsAscii, hexSlice, imageFromBinary, parseIntelHex, type HexImage} from './intel-hex.ts';
import type {FirmwareRelease} from './manifest.ts';
import type {EscMcu, EscTarget} from './targets.ts';

export class Am32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Am32Error';
  }
}

/**
 * F4: the final whole-image read-back after the last write did not match.
 * `disabled` is true when the first app page was erased again afterwards
 * (read back blank), so the bootloader stays in charge and the motor stays silent.
 */
export class Am32FinalVerifyError extends Am32Error {
  readonly disabled: boolean;
  constructor(message: string, disabled: boolean) {
    super(message);
    this.name = 'Am32FinalVerifyError';
    this.disabled = disabled;
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
  /** The pinned EEPROM v4 defaults (192 B), or null when the image is only for the esc-configurator download. flashAm32 refuses null. */
  eeprom: Uint8Array | null;
};

/**
 * Parse and check a verified AM32 app for one ESC target: Intel HEX text, or a
 * raw .bin (Uint8Array, staging) that starts at the AM32 app address. `eeprom`
 * is the pinned defaults blob: exactly 192 bytes, EEPROM layout version 4.
 * Rejects: data in
 * the bootloader, in the EEPROM page or past the app area; an image whose
 * name slot (0x08007BE0, same parser as the ESC read) is not exactly the
 * target's name; an image that also carries another ESC's name anywhere.
 */
export function prepareAm32Image(source: string | Uint8Array, target: EscTarget, eeprom: Uint8Array | null = null): Am32Image {
  if (eeprom !== null) {
    if (eeprom.length !== AM32_EEPROM_DEFAULTS_SIZE) {
      throw new Am32Error(`The EEPROM defaults must be ${AM32_EEPROM_DEFAULTS_SIZE} bytes, not ${eeprom.length}.`);
    }
    if (eeprom[AM32_EEPROM_LAYOUT_VERSION_INDEX] !== 4) throw new Am32Error('The EEPROM defaults are not EEPROM layout v4.');
  }
  const hex: HexImage =
    typeof source === 'string' ? parseIntelHex(source) : imageFromBinary(source, AT32F421_FLASH_BASE + AM32_APP_START);
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
  return {target: target.target, pages, start, end, eeprom: eeprom ? Uint8Array.from(eeprom) : null};
}

export type Am32Phase = 'identify' | 'erase-first' | 'write' | 'write-eeprom' | 'write-first' | 'check-eeprom' | 'reset';

/** How each erased page became blank (F5): 'page-erase' = DevicePageErase did it; 'aligned-write' = the 0xFF fallback did. */
export type Am32EraseRecord = {offset: number; path: 'page-erase' | 'aligned-write'};

/** What flashAm32 did, for the bench record. */
export type Am32FlashReport = {erases: Am32EraseRecord[]};

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
): Promise<Am32FlashReport> {
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
  const eeprom = image.eeprom;
  if (!eeprom) throw new Am32Error('The image has no EEPROM defaults; refusing a partial install.');
  assertAm32EepromWritable(AM32_EEPROM_OFFSET, eeprom.length);

  const [firstPage, ...others] = image.pages;
  if (!firstPage || firstPage.offset !== AM32_APP_START) throw new Am32Error('Image has no first app page.');
  // The page holding the name slot goes first, so the identity is rewritten right away.
  const slotPage = AM32_NAME_SLOT_OFFSET - (AM32_NAME_SLOT_OFFSET % AM32_PAGE_SIZE);
  const rest = [...others.filter((p) => p.offset === slotPage), ...others.filter((p) => p.offset !== slotPage)];
  const report: Am32FlashReport = {erases: []};
  onProgress('erase-first', 0, total);
  report.erases.push(await erasePage(fw, firstPage.offset));

  let done = 0;
  for (const p of rest) {
    report.erases.push(await erasePage(fw, p.offset));
    await writeAndVerify(fw, p);
    onProgress('write', ++done, total);
  }
  onProgress('write-eeprom', done, total);
  report.erases.push(await writeEepromDefaults(fw, eeprom));
  onProgress('write-first', done, total);
  await writeAndVerify(fw, firstPage);
  onProgress('check-eeprom', ++done, total);
  await verifyWholeImage(fw, image.pages, eeprom);
  onProgress('reset', done, total);
  await fw.resetEsc(index);
  return report;
}

/**
 * F4: after the last write, read back every app page (name slot included) and
 * the EEPROM page and require them equal to the image and the pinned defaults.
 * On a mismatch, erase the first app page again (best effort, same guards and
 * gates) so the hybrid app cannot start, then throw Am32FinalVerifyError.
 */
async function verifyWholeImage(fw: FourWay, pages: readonly Am32Page[], eeprom: Uint8Array): Promise<void> {
  let problem: string | null = null;
  try {
    for (const p of pages) {
      const back = await fw.readRange(p.offset, p.data.length);
      const bad = back.findIndex((b, i) => b !== p.data[i]);
      if (back.length !== p.data.length || bad >= 0) {
        problem = `the firmware at 0x${(AT32F421_FLASH_BASE + p.offset + Math.max(bad, 0)).toString(16)} changed after it was written and checked`;
        break;
      }
    }
    if (!problem) await checkEeprom(fw, eeprom);
  } catch (e) {
    problem ??= (e as Error).message;
  }
  if (!problem) return;
  let disabled = false;
  const first = pages[0];
  if (first) {
    try {
      await erasePage(fw, first.offset);
      disabled = true;
    } catch {
      disabled = false;
    }
  }
  throw new Am32FinalVerifyError(`Final check failed: ${problem}. The ESC is NOT installed.`, disabled);
}

/** Erase the EEPROM page (must read back all 0xFF), write the pinned defaults, read back and compare. */
async function writeEepromDefaults(fw: FourWay, eeprom: Uint8Array): Promise<Am32EraseRecord> {
  assertAm32EepromWritable(AM32_EEPROM_OFFSET, eeprom.length);
  assertAm32EepromPageErasable(AM32_EEPROM_OFFSET);
  if (eeprom.length > FOURWAY_MAX_CHUNK) throw new Am32Error('EEPROM defaults do not fit one write.');
  await fw.pageEraseUnchecked(AM32_EEPROM_OFFSET / AM32_PAGE_SIZE);
  let path: Am32EraseRecord['path'] = 'page-erase';
  if (!(await isBlank(fw, AM32_EEPROM_OFFSET, AM32_EEPROM_SIZE))) {
    // F5 fallback: an aligned 0xFF write of exactly (0x7C00, 192), the only range the EEPROM guard admits.
    const ff = new Uint8Array(eeprom.length).fill(0xff);
    assertAm32EepromWritable(AM32_EEPROM_OFFSET, ff.length);
    await fallbackWrite(fw, AM32_EEPROM_OFFSET, ff, 'the settings page');
    if (!(await isBlank(fw, AM32_EEPROM_OFFSET, AM32_EEPROM_SIZE))) {
      throw new Am32Error(
        'The ESC did not erase the settings page (page erase and aligned-write fallback). Stopped before writing the defaults.',
      );
    }
    path = 'aligned-write';
  }
  await fw.writeUnchecked(AM32_EEPROM_OFFSET, eeprom);
  await checkEeprom(fw, eeprom);
  return {offset: AM32_EEPROM_OFFSET, path};
}

async function isBlank(fw: FourWay, offset: number, size: number): Promise<boolean> {
  return (await fw.readRange(offset, size)).every((b) => b === 0xff);
}

/** F5: the 0xFF fallback write. A NACK or timeout here also stops the install (fail-closed). */
async function fallbackWrite(fw: FourWay, offset: number, ff: Uint8Array, what: string): Promise<void> {
  try {
    await fw.writeUnchecked(offset, ff);
  } catch (e) {
    throw new Am32Error(`The ESC did not erase ${what}, and the erase fallback failed (${(e as Error).message}). Stopped before writing.`);
  }
}

/** The settings page must equal the pinned defaults (first 192 bytes) and be erased (0xFF) after them. */
async function checkEeprom(fw: FourWay, eeprom: Uint8Array): Promise<void> {
  const page = await fw.readRange(AM32_EEPROM_OFFSET, AM32_EEPROM_SIZE);
  if (!equal(page.subarray(0, eeprom.length), eeprom) || page.subarray(eeprom.length).some((b) => b !== 0xff)) {
    throw new Am32Error('The ESC settings page does not equal the pinned defaults after the write.');
  }
}

/**
 * Erase one app page and read it back (F4): the page must be all 0xFF before
 * anything else happens. A bootloader that ACKs the erase without doing it
 * (or erases another page) stops the update here, with the old vector table
 * still intact, instead of producing a hybrid image.
 */
async function erasePage(fw: FourWay, offset: number): Promise<Am32EraseRecord> {
  assertAm32Writable(offset, AM32_PAGE_SIZE);
  if (offset % AM32_PAGE_SIZE) throw new Am32Error('Unaligned page erase.');
  await fw.pageEraseUnchecked(offset / AM32_PAGE_SIZE);
  if (await isBlank(fw, offset, AM32_PAGE_SIZE)) return {offset, path: 'page-erase'};
  // F5 fallback: 0xFF at the aligned page start, through the same app address guard.
  const ff = new Uint8Array(FOURWAY_MAX_CHUNK).fill(0xff);
  assertAm32Writable(offset, ff.length);
  const where = `the page at 0x${(AT32F421_FLASH_BASE + offset).toString(16)}`;
  await fallbackWrite(fw, offset, ff, where);
  const back = await fw.readRange(offset, AM32_PAGE_SIZE);
  const bad = back.findIndex((b) => b !== 0xff);
  if (bad >= 0) {
    throw new Am32Error(
      `The ESC did not erase ${where} (byte 0x${(AT32F421_FLASH_BASE + offset + bad).toString(16)} is not blank after the page erase and the aligned-write fallback). Stopped before writing.`,
    );
  }
  return {offset, path: 'aligned-write'};
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

