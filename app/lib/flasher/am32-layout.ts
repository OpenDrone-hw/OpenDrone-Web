/**
 * AM32 on AT32F421 (OpenESC): every address and identity constant the ESC
 * flasher uses, in one place.
 *
 * Sources: the AM32 project's public documentation and target list (target
 * names only), the AT32F421 reference manual (flash base, 1 KB pages), and
 * the BLHeli 4-way interface protocol description. No AM32, esc-configurator,
 * BLHeliSuite or Betaflight code was copied; these are facts, not code.
 *
 * Flash map the flasher assumes (offsets from the flash base, which is also
 * what the 4-way protocol's 16-bit address field carries on ARM):
 *
 *   0x0000 .. 0x0FFF  AM32 bootloader (4 KB)             NEVER written
 *   0x1000 .. 0x7BFF  AM32 application                   written + verified
 *     0x7BE0 .. 0x7BFF  name slot (AM32 FILE_NAME), last 32 bytes of the app area: ESC identity
 *   0x7C00 .. 0x7FFF  EEPROM / settings page (1 KB)      NEVER written, compared before/after
 *   0x8000 ..         rest of a 64 KB part               NEVER written
 *
 * FAIL-CLOSED GATES: every constant below that was not confirmed on an
 * OpenESC with the AM32 bootloader is covered by an AM32_*_VERIFIED flag.
 * While ANY of them is false the page does not write to an ESC at all. It
 * offers the verified file for esc-configurator.com instead. There is no
 * override. Flip a flag only in a reviewed PR that records how it was checked
 * (e.g. a read-only dump over the 4-way interface compared with a SWD read).
 */

/** AT32F421 main flash base (reference manual memory map). */
export const AT32F421_FLASH_BASE = 0x08000000;

/** AT32F421G8 erase page size: 1 KB. */
export const AM32_PAGE_SIZE = 0x400;

/** AM32 bootloader occupies the first 4 KB. The flasher never writes, erases or reads into it for writing. */
export const AM32_BOOTLOADER_SIZE = 0x1000;

/** First byte of the AM32 application (offset from the flash base). */
export const AM32_APP_START = AM32_BOOTLOADER_SIZE;

/** AM32 EEPROM (settings) page offset on F421 builds, and its size (one page). */
export const AM32_EEPROM_OFFSET = 0x7c00;
export const AM32_EEPROM_SIZE = AM32_PAGE_SIZE;

/** The application must end before the EEPROM page. */
export const AM32_APP_END = AM32_EEPROM_OFFSET;

/**
 * AM32 EEPROM byte layout (settings page, EEPROM v4): byte 1 = EEPROM layout
 * version, byte 2 = bootloader version, bytes 3..4 = firmware major/minor.
 * Bytes 5.. are SETTINGS (max ramp, min duty, PID, brake, ...), NOT a name:
 * the configurator's DEFAULT v4 page has binary settings there (and a stray
 * "51 " at 14..16). Never read the ESC identity from this page.
 */
export const AM32_EEPROM_LAYOUT_VERSION_INDEX = 1;
export const AM32_EEPROM_BOOTLOADER_VERSION_INDEX = 2;
export const AM32_EEPROM_FW_MAJOR_INDEX = 3;
export const AM32_EEPROM_FW_MINOR_INDEX = 4;

/**
 * ESC IDENTITY: the AM32 name slot (FILE_NAME), 32 bytes right before the
 * EEPROM page.
 *
 * Derivation (2026-11-02):
 *   - AM32 upstream (am32-firmware/AM32 @ 86cf1e5), Mcu/f421/AT32F421x6_FLASH.ld:
 *       FLASH     ORIGIN = 0x08001000, LENGTH = 27K   (app linked at 0x08001000)
 *       EEPROM    ORIGIN = 0x08007C00, LENGTH = 1K
 *       FILE_NAME ORIGIN = ORIGIN(EEPROM) - 32, LENGTH = 32   => 0x08007BE0
 *     and the `.file_name` output section is ALIGN(4)-padded into FILE_NAME.
 *   - Src/main.c: `const char filename[30] AM32_FLASH_SECTION(".file_name") = FILE_NAME;`
 *     so the slot holds the target name (here "OPENESC_20_F421", the AM32
 *     FILE_NAME = release file target), NUL terminated, NUL padded to 30 bytes,
 *     plus 2 alignment bytes (0x00) to 32.
 *   - The OpenESC-20x20 QC bench image (private, hashed only) is a FULL image
 *     based at 0x08000000: bootloader at 0x0000, app binary from 0x1000 (its
 *     vector table's reset vector points into 0x08001000+), settings at 0x7C00.
 *     Image offset 0x7BE0 = app-binary offset 0x6BE0 = flash 0x08007BE0, and
 *     it holds "OPENESC_20_F421" followed by 17 x 0x00. The fork's
 *     FIRMWARE_NAME ("OpenESC_20") does not appear anywhere in that binary.
 *   - The 4-way interface addresses ESC flash by offset from 0x08000000
 *     (toFourWayOffset), so the read is offset 0x7BE0, length 32.
 * This sits inside the app area, so it is part of every app image and is
 * rewritten by every update (am32.ts writes that page right after the first
 * erase, so an interrupted update rarely leaves it blank).
 *
 * Gated: AM32_LAYOUT_VERIFIED (address) and AM32_EEPROM_LAYOUT_VERIFIED
 * (slot contents/padding read over 4-way vs SWD). Bench item B8.
 */
export const AM32_NAME_SLOT_OFFSET = AM32_EEPROM_OFFSET - 32; // 0x7BE0
export const AM32_NAME_SLOT_SIZE = 32;
/** `filename[30]`: name + NUL terminator must fit in the first 30 bytes; the rest is alignment. */
export const AM32_NAME_ARRAY_SIZE = 30;

/**
 * 4-way cmd_DeviceInitFlash reply (4 bytes) on an ARM bootloader: signature
 * low byte, signature high byte, bootloader info byte, interface mode.
 */
export const FOURWAY_DEVICE_INFO_SIG_LO_INDEX = 0;
export const FOURWAY_DEVICE_INFO_SIG_HI_INDEX = 1;
export const FOURWAY_DEVICE_INFO_MODE_INDEX = 3;
/** Interface mode reported for an ARM (AM32-type) bootloader. */
export const FOURWAY_MODE_ARM_BLB = 4;

/** Bootloader signature reported by the AM32 bootloader on AT32F421. */
export const AM32_SIGNATURE_AT32F421 = 0x4706;

/** Known AM32 MCU signatures, so a mismatch can say what it found. Anything else is "unknown". */
export const AM32_MCU_SIGNATURES: Readonly<Record<number, string>> = {
  [AM32_SIGNATURE_AT32F421]: 'AT32F421',
};

/** Largest 4-way read/write payload. */
export const FOURWAY_MAX_CHUNK = 256;

// ---------------------------------------------------------------------------
// Hardware-verify gates. ALL false: direct ESC writes are disabled.
// ---------------------------------------------------------------------------

/** Bootloader size, app start, EEPROM offset/size and page size above, checked on an OpenESC. */
export const AM32_LAYOUT_VERIFIED = false;
/** cmd_DeviceInitFlash reply byte order and the AT32F421 signature value, checked on an OpenESC. */
export const AM32_SIGNATURE_VERIFIED = false;
/**
 * ESC identity read: the name slot at 0x7BE0..0x7BFF (AM32_NAME_SLOT_OFFSET)
 * holds "OPENESC_20_F421" NUL padded on a QC'd OpenESC (4-way read vs SWD
 * dump, bench B8/B9), and the EEPROM v4 header bytes 1..4. The flag keeps its
 * historical name; it no longer covers a name inside the EEPROM page.
 */
export const AM32_EEPROM_LAYOUT_VERIFIED = false;
/**
 * The write procedure on the AM32 bootloader: cmd_DevicePageErase takes a
 * page number, cmd_DeviceWrite does not erase on its own, a cleared first app
 * page keeps the bootloader from jumping to a half-written app, and
 * read-back returns flash contents.
 */
export const AM32_WRITE_PROCEDURE_VERIFIED = false;

export const AM32_GATES = {
  AM32_LAYOUT_VERIFIED,
  AM32_SIGNATURE_VERIFIED,
  AM32_EEPROM_LAYOUT_VERIFIED,
  AM32_WRITE_PROCEDURE_VERIFIED,
} as const;

export type Am32Gates = {[K in keyof typeof AM32_GATES]: boolean};

/**
 * TEST-ONLY SEAM (F1, review-fable-2). The simulated-ESC unit tests need to
 * drive the real erase/write path while the shipped constants stay false.
 * The seam opens only when ALL of these hold:
 *   - there is no `window` (not a browser page);
 *   - a Node.js `process` global exists (`process.versions.node`);
 *   - `process.env.OPENDRONE_SIMULATED_ESC_WRITES === AM32_TEST_SEAM_VALUE`.
 * A browser has no `process` global and no environment, so nothing on /flash
 * can open it; there is no function to call, no argument and no UI control.
 * Only `flasher.test.ts` sets the variable, around the simulated-ESC tests.
 * It is read through `globalThis` on purpose so no bundler can inline it.
 */
export const AM32_TEST_SEAM_ENV = 'OPENDRONE_SIMULATED_ESC_WRITES';
export const AM32_TEST_SEAM_VALUE = 'simulated-esc-only';

function am32TestSeamOpen(): boolean {
  const g = globalThis as unknown as {window?: unknown; process?: {versions?: {node?: string}; env?: Record<string, string | undefined>}};
  if (typeof g.window !== 'undefined') return false;
  const p = g.process;
  return !!p?.versions?.node && p.env?.[AM32_TEST_SEAM_ENV] === AM32_TEST_SEAM_VALUE;
}

/** True only when every shipped AM32_*_VERIFIED constant is true (or the Node-only test seam is open). Reads the constants, never a parameter. */
export function am32WritesEnabled(): boolean {
  return Object.values(AM32_GATES).every(Boolean) || am32TestSeamOpen();
}

export class Am32WriteDisabledError extends Error {
  constructor() {
    super('Direct ESC writes are disabled until every AM32_*_VERIFIED flag is confirmed on hardware. Use esc-configurator with the verified file.');
    this.name = 'Am32WriteDisabledError';
  }
}

/** Hard check used inside the lowest-level 4-way erase/write primitives and in flashAm32. */
export function assertAm32WritesEnabled(): void {
  if (!am32WritesEnabled()) throw new Am32WriteDisabledError();
}

/** Fallback when direct writes are disabled. Link only: no esc-configurator code is used. */
export const ESC_CONFIGURATOR_URL = 'https://esc-configurator.com/';

export class Am32AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Am32AddressError';
  }
}

const hex = (n: number) => `0x${n.toString(16).padStart(4, '0')}`;

/**
 * The address guard. Every erase and write the ESC flasher issues goes
 * through here. A range that touches the bootloader, the EEPROM page or
 * anything past the app area throws.
 */
export function assertAm32Writable(offset: number, length: number): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
    throw new Am32AddressError(`Invalid write range ${offset}+${length}.`);
  }
  const end = offset + length;
  if (offset < AM32_APP_START) {
    throw new Am32AddressError(`Refusing to write ${hex(offset)}: inside the AM32 bootloader (below ${hex(AM32_APP_START)}).`);
  }
  if (offset < AM32_EEPROM_OFFSET + AM32_EEPROM_SIZE && end > AM32_EEPROM_OFFSET) {
    throw new Am32AddressError(`Refusing to write ${hex(offset)}..${hex(end)}: overlaps the EEPROM/settings page.`);
  }
  if (end > AM32_APP_END) {
    throw new Am32AddressError(`Refusing to write ${hex(offset)}..${hex(end)}: past the end of the application area.`);
  }
}

/** Convert an absolute AT32F421 address to the 16-bit 4-way offset, or throw. */
export function toFourWayOffset(absolute: number): number {
  const off = absolute - AT32F421_FLASH_BASE;
  if (off < 0 || off > 0xffff) throw new Am32AddressError(`Address 0x${absolute.toString(16)} is not in ESC flash.`);
  return off;
}
