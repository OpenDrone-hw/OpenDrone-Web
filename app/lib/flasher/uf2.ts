/**
 * UF2 parsing and validation for RP2350 images.
 *
 * Format: https://github.com/microsoft/uf2 (512-byte blocks, two start magics,
 * one end magic, optional family ID). The flasher never hands a UF2 to the
 * user or to the board without passing it through `parseUf2` first: a file
 * that fails here is never downloaded, never written.
 *
 * Pure module (no DOM), so it runs under `node --test`.
 */

export const UF2_BLOCK_SIZE = 512;
const MAGIC_START0 = 0x0a324655;
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;
const FLAG_NOT_MAIN_FLASH = 0x00000001;
const FLAG_FAMILY_ID_PRESENT = 0x00002000;

/** UF2 family IDs (microsoft/uf2 utils/uf2families.json, pico-sdk boot/uf2.h). */
export const UF2_FAMILY = {
  RP2040: 0xe48bff56,
  ABSOLUTE: 0xe48bff57,
  DATA: 0xe48bff58,
  RP2350_ARM_S: 0xe48bff59,
  RP2350_RISCV: 0xe48bff5a,
  RP2350_ARM_NS: 0xe48bff5b,
} as const;

/** RP2350 flash is XIP-mapped at this address. */
export const RP2350_FLASH_BASE = 0x10000000;
export const FLASH_PAGE_SIZE = 256;
export const FLASH_SECTOR_SIZE = 4096;

export type Uf2Page = {addr: number; data: Uint8Array};

export type Uf2Image = {
  familyId: number;
  /** Payload pages for the target family, sorted by address, 256 bytes each. */
  pages: Uf2Page[];
  /** Lowest and one-past-highest flash address the image touches. */
  start: number;
  end: number;
  /** Blocks of the ABSOLUTE family (RP2350-E10 workaround block). Not written. */
  ignoredBlocks: number;
};

export class Uf2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Uf2Error';
  }
}

/**
 * Parse and validate a UF2 file for one family and flash size.
 *
 * Rejects: wrong length, bad magics, a block for another family (except the
 * ABSOLUTE-family erratum block, which is ignored), missing family ID,
 * payloads other than 256 bytes, unaligned or out-of-range addresses,
 * duplicate addresses, and block numbering that is not a complete 0..n-1 run.
 */
export function parseUf2(
  bytes: Uint8Array,
  opts: {familyId: number; flashSize: number; flashBase?: number},
): Uf2Image {
  const flashBase = opts.flashBase ?? RP2350_FLASH_BASE;
  const flashEnd = flashBase + opts.flashSize;
  if (bytes.length === 0 || bytes.length % UF2_BLOCK_SIZE !== 0) {
    throw new Uf2Error(`File length ${bytes.length} is not a whole number of 512-byte UF2 blocks.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length / UF2_BLOCK_SIZE;
  const pages = new Map<number, Uint8Array>();
  let ignoredBlocks = 0;
  let expectedTotal: number | null = null;
  const seenBlockNos = new Set<number>();
  const absolute: {blockNo: number; numBlocks: number}[] = [];

  for (let i = 0; i < count; i++) {
    const o = i * UF2_BLOCK_SIZE;
    const u32 = (off: number) => view.getUint32(o + off, true);
    if (u32(0) !== MAGIC_START0 || u32(4) !== MAGIC_START1 || u32(508) !== MAGIC_END) {
      throw new Uf2Error(`Block ${i}: bad UF2 magic.`);
    }
    const flags = u32(8);
    const addr = u32(12);
    const size = u32(16);
    const blockNo = u32(20);
    const numBlocks = u32(24);
    const family = u32(28);
    if (flags & FLAG_NOT_MAIN_FLASH) {
      throw new Uf2Error(`Block ${i}: marked not-main-flash; not an RP2350 firmware image.`);
    }
    if (!(flags & FLAG_FAMILY_ID_PRESENT)) {
      throw new Uf2Error(`Block ${i}: no family ID; refusing an image that does not say which chip it is for.`);
    }
    if (family === UF2_FAMILY.ABSOLUTE) {
      // pico-sdk/picotool prepend one ABSOLUTE-family block as the RP2350-E10
      // workaround. The bootrom discards it; so do we.
      ignoredBlocks++;
      absolute.push({blockNo: u32(20), numBlocks: u32(24)});
      continue;
    }
    if (family !== opts.familyId) {
      throw new Uf2Error(
        `Block ${i}: family 0x${family.toString(16)} does not match the expected 0x${opts.familyId.toString(16)}.`,
      );
    }
    if (size !== FLASH_PAGE_SIZE) {
      throw new Uf2Error(`Block ${i}: payload ${size} bytes, expected ${FLASH_PAGE_SIZE}.`);
    }
    if (addr % FLASH_PAGE_SIZE !== 0 || addr < flashBase || addr + size > flashEnd) {
      throw new Uf2Error(`Block ${i}: address 0x${addr.toString(16)} is outside the board's flash.`);
    }
    if (expectedTotal === null) expectedTotal = numBlocks;
    if (numBlocks !== expectedTotal || blockNo >= numBlocks || seenBlockNos.has(blockNo)) {
      throw new Uf2Error(`Block ${i}: inconsistent block numbering (${blockNo}/${numBlocks}).`);
    }
    seenBlockNos.add(blockNo);
    if (pages.has(addr)) {
      throw new Uf2Error(`Block ${i}: address 0x${addr.toString(16)} appears twice.`);
    }
    pages.set(addr, bytes.slice(o + 32, o + 32 + size));
  }

  if (expectedTotal === null || pages.size === 0) {
    throw new Uf2Error('No firmware blocks for this chip in the file.');
  }
  // Toolchains differ on whether the ABSOLUTE block is counted in numBlocks
  // (its own 1-block run, or block 0 of the image's run). Accept both, nothing else.
  for (const abs of absolute) {
    if (abs.numBlocks === expectedTotal && !seenBlockNos.has(abs.blockNo)) seenBlockNos.add(abs.blockNo);
  }
  if (seenBlockNos.size !== expectedTotal) {
    throw new Uf2Error(`File is truncated: ${seenBlockNos.size} of ${expectedTotal} blocks present.`);
  }
  const sorted = [...pages.entries()].sort((a, b) => a[0] - b[0]).map(([addr, data]) => ({addr, data}));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) throw new Uf2Error('No firmware blocks for this chip in the file.');
  return {
    familyId: opts.familyId,
    pages: sorted,
    start: first.addr,
    end: last.addr + FLASH_PAGE_SIZE,
    ignoredBlocks,
  };
}

/** Group pages into 4 KB sectors (address -> 4096-byte buffer, 0xFF filled). */
export function sectorsOf(image: Uf2Image): Map<number, Uint8Array> {
  const sectors = new Map<number, Uint8Array>();
  for (const page of image.pages) {
    const base = page.addr - (page.addr % FLASH_SECTOR_SIZE);
    let buf = sectors.get(base);
    if (!buf) {
      buf = new Uint8Array(FLASH_SECTOR_SIZE).fill(0xff);
      sectors.set(base, buf);
    }
    buf.set(page.data, page.addr - base);
  }
  return sectors;
}

/** Find an ASCII string inside an image's payload (e.g. a Betaflight target name). */
export function imageContainsAscii(image: Uf2Image, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  // Pages are contiguous in practice; scan each page plus an overlap with the next.
  for (let i = 0; i < image.pages.length; i++) {
    const page = image.pages[i];
    if (!page) continue;
    const next = image.pages[i + 1];
    const window =
      next && next.addr === page.addr + FLASH_PAGE_SIZE
        ? concat(page.data, next.data.subarray(0, target.length - 1))
        : page.data;
    if (indexOf(window, target) >= 0) return true;
  }
  return false;
}

export function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Parse INFO_UF2.TXT from a BOOTSEL drive into key/value pairs. */
export function parseInfoUf2(text: string): {model?: string; boardId?: string; raw: Record<string, string>} {
  const raw: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (m && m[1] && m[2] !== undefined) raw[m[1].trim()] = m[2].trim();
  }
  return {model: raw['Model'], boardId: raw['Board-ID'], raw};
}
