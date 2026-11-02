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
 * AM32 EEPROM byte layout (settings page): byte 1 = EEPROM layout version,
 * byte 2 = bootloader version, bytes 3..4 = firmware major/minor, bytes
 * 5..16 = firmware name (12 ASCII bytes, space padded, AM32 FIRMWARE_NAME).
 */
export const AM32_EEPROM_LAYOUT_VERSION_INDEX = 1;
export const AM32_EEPROM_BOOTLOADER_VERSION_INDEX = 2;
export const AM32_EEPROM_FW_MAJOR_INDEX = 3;
export const AM32_EEPROM_FW_MINOR_INDEX = 4;
export const AM32_EEPROM_NAME_INDEX = 5;
export const AM32_EEPROM_NAME_LENGTH = 12;

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
/** EEPROM byte layout (firmware name offset/length), checked against a read of a flashed OpenESC. */
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
