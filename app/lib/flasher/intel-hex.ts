/**
 * Intel HEX parser (AM32 release files are .hex). Written from the Intel HEX
 * format description: `:LLAAAATT<data>CC`, two's-complement checksum, record
 * types 00 data, 01 EOF, 02 extended segment address, 04 extended linear
 * address, 03/05 start address (ignored: nothing is executed from them).
 *
 * Pure module, runs under `node --test`.
 */

export class IntelHexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntelHexError';
  }
}

export type HexImage = {
  /** Lowest and one-past-highest absolute address with data. */
  start: number;
  end: number;
  /** Byte at absolute address, for every address the file defines. */
  bytes: Map<number, number>;
};

/** Hard cap so a hostile file cannot make the page allocate without bound. */
const MAX_BYTES = 1024 * 1024;

export function parseIntelHex(text: string): HexImage {
  const bytes = new Map<number, number>();
  let upper = 0;
  let sawEof = false;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? '').trim();
    if (!line) continue;
    if (sawEof) throw new IntelHexError(`Line ${n + 1}: data after the end-of-file record.`);
    if (!/^:([0-9A-Fa-f]{2})+$/.test(line) || line.length < 11) {
      throw new IntelHexError(`Line ${n + 1}: not an Intel HEX record.`);
    }
    const rec = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < rec.length; i++) rec[i] = parseInt(line.slice(1 + i * 2, 3 + i * 2), 16);
    const len = rec[0] ?? 0;
    if (rec.length !== len + 5) throw new IntelHexError(`Line ${n + 1}: length field does not match the record.`);
    let sum = 0;
    for (const b of rec) sum = (sum + b) & 0xff;
    if (sum !== 0) throw new IntelHexError(`Line ${n + 1}: checksum error.`);
    const addr = ((rec[1] ?? 0) << 8) | (rec[2] ?? 0);
    const type = rec[3];
    const data = rec.subarray(4, 4 + len);
    switch (type) {
      case 0x00: {
        for (let i = 0; i < len; i++) {
          const a = upper + addr + i;
          if (bytes.has(a)) throw new IntelHexError(`Line ${n + 1}: address 0x${a.toString(16)} defined twice.`);
          bytes.set(a, data[i] ?? 0xff);
          if (a < start) start = a;
          if (a + 1 > end) end = a + 1;
        }
        if (bytes.size > MAX_BYTES) throw new IntelHexError('File is larger than any ESC flash.');
        break;
      }
      case 0x01:
        sawEof = true;
        break;
      case 0x02:
        if (len !== 2) throw new IntelHexError(`Line ${n + 1}: bad segment address record.`);
        upper = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 4;
        break;
      case 0x04:
        if (len !== 2) throw new IntelHexError(`Line ${n + 1}: bad linear address record.`);
        upper = ((((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 16) >>> 0;
        break;
      case 0x03:
      case 0x05:
        break;
      default:
        throw new IntelHexError(`Line ${n + 1}: unknown record type ${type}.`);
    }
  }
  if (!sawEof) throw new IntelHexError('File has no end-of-file record (truncated?).');
  if (bytes.size === 0) throw new IntelHexError('File contains no data.');
  return {start, end, bytes};
}

/**
 * Raw binary at a known absolute base address (a staging .bin app), as the
 * same HexImage the Intel HEX parser produces, so every later check (address
 * guard, name slot, ambiguous names) is the same code path.
 */
export function imageFromBinary(bytes: Uint8Array, base: number): HexImage {
  if (bytes.length === 0) throw new IntelHexError('File contains no data.');
  if (bytes.length > MAX_BYTES) throw new IntelHexError('File is larger than any ESC flash.');
  const map = new Map<number, number>();
  for (let i = 0; i < bytes.length; i++) map.set(base + i, bytes[i] ?? 0xff);
  return {start: base, end: base + bytes.length, bytes: map};
}

/** Contiguous 0xFF-filled buffer for [from, to). */
export function hexSlice(image: HexImage, from: number, to: number): Uint8Array {
  const out = new Uint8Array(to - from).fill(0xff);
  for (let a = from; a < to; a++) {
    const b = image.bytes.get(a);
    if (b !== undefined) out[a - from] = b;
  }
  return out;
}

/** Whether the image contains an ASCII string anywhere in its data. */
export function hexContainsAscii(image: HexImage, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  if (!n.length) return false;
  for (const [a, b] of image.bytes) {
    if (b !== n[0]) continue;
    let ok = true;
    for (let i = 1; i < n.length && ok; i++) ok = image.bytes.get(a + i) === n[i];
    if (ok) return true;
  }
  return false;
}
