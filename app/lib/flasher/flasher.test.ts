import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {
  AM32_APP_START,
  AM32_EEPROM_NAME_INDEX,
  AM32_EEPROM_OFFSET,
  AM32_GATES,
  AM32_PAGE_SIZE,
  AM32_SIGNATURE_AT32F421,
  AT32F421_FLASH_BASE,
  Am32AddressError,
  FOURWAY_MODE_ARM_BLB,
  assertAm32Writable,
  type Am32Gates,
} from './am32-layout.ts';
import {Am32Error, classifyMcu, flashAm32, identifyEsc, parseEepromFirmwareName, prepareAm32Image} from './am32.ts';
import {FIRMWARE_MANIFEST} from './firmware-manifest.ts';
import {FOURWAY_CMD, FourWay, crc16Xmodem, decodeFourWay, encodeFourWay, parseDeviceInfo} from './fourway.ts';
import {
  FC_GATES,
  escDirectWriteGate,
  escTargetProblems,
  fcDirectWriteGate,
  fcTargetProblems,
  type FcDirectWriteInput,
  type EscDirectWriteInput,
} from './gates.ts';
import {IntelHexError, parseIntelHex} from './intel-hex.ts';
import {
  FirmwareNotPublishedError,
  ManifestError,
  PLACEHOLDER_SHA256,
  fetchVerifiedFirmware,
  isPublished,
  resolveRelease,
  sha256Hex,
  verifyFirmwareBytes,
  type FirmwareRelease,
} from './manifest.ts';
import {MSP, decodeMspV1, encodeMspV1, parseBoardInfo} from './msp.ts';
import type {ByteLink, Decoded} from './serial-link.ts';
import {CHIP_PACKAGE_VERIFIED, ESC_TARGETS, FLASHER_TARGETS, PICOBOOT_WRITE_VERIFIED} from './targets.ts';
import {UF2_FAMILY, Uf2Error, imageContainsAscii, parseInfoUf2, parseUf2, sectorsOf} from './uf2.ts';

const MINI = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_MINI_RP2350A')!;
const LITE = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_RP2350B')!;
const ESC20 = ESC_TARGETS[0]!;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a UF2 in memory: `pages` payload pages from 0x10000000, optional ABSOLUTE erratum block first. */
function makeUf2(opts: {pages: number; name: string; family?: number; absolute?: boolean; addrBase?: number}): Uint8Array {
  const blocks: Uint8Array[] = [];
  const block = (addr: number, blockNo: number, numBlocks: number, family: number, fill: (d: Uint8Array) => void) => {
    const b = new Uint8Array(512);
    const v = new DataView(b.buffer);
    v.setUint32(0, 0x0a324655, true);
    v.setUint32(4, 0x9e5d5157, true);
    v.setUint32(8, 0x00002000, true);
    v.setUint32(12, addr, true);
    v.setUint32(16, 256, true);
    v.setUint32(20, blockNo, true);
    v.setUint32(24, numBlocks, true);
    v.setUint32(28, family, true);
    fill(b.subarray(32, 32 + 256));
    v.setUint32(508, 0x0ab16f30, true);
    blocks.push(b);
  };
  if (opts.absolute) block(0x10ffff00, 0, 2, UF2_FAMILY.ABSOLUTE, (d) => d.fill(0xef));
  const base = opts.addrBase ?? 0x10000000;
  for (let i = 0; i < opts.pages; i++) {
    block(base + i * 256, i, opts.pages, opts.family ?? UF2_FAMILY.RP2350_ARM_S, (d) => {
      d.fill(i & 0xff);
      if (i === 5) d.set(new TextEncoder().encode(opts.name), 16);
    });
  }
  const out = new Uint8Array(blocks.length * 512);
  blocks.forEach((b, i) => out.set(b, i * 512));
  return out;
}

const uf2Opts = {familyId: UF2_FAMILY.RP2350_ARM_S, flashSize: 2 * 1024 * 1024};

function hexRecord(type: number, addr: number, data: number[]): string {
  const rec = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const sum = (0x100 - (rec.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
  return ':' + [...rec, sum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** Intel HEX with `bytes` at absolute `start`, split into 16-byte records. */
function makeHex(start: number, bytes: Uint8Array): string {
  const lines = [hexRecord(0x04, 0, [(start >>> 24) & 0xff, (start >>> 16) & 0xff])];
  for (let o = 0; o < bytes.length; o += 16) lines.push(hexRecord(0x00, (start + o) & 0xffff, [...bytes.subarray(o, o + 16)]));
  lines.push(hexRecord(0x01, 0, []));
  return lines.join('\r\n') + '\r\n';
}

/** A small AM32-like app image: 3 KB from the app start, carrying the padded firmware name. */
function makeAm32App(name = 'OpenESC_20  ', size = 3 * 1024): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7) & 0xff;
  b.set(new TextEncoder().encode(name), 0x200);
  return b;
}

const published = (over: Partial<FirmwareRelease> = {}): FirmwareRelease => ({
  target: MINI.target,
  kind: 'betaflight-uf2',
  version: 'test',
  firmware: 'test',
  channel: 'stable',
  released: '2026-11-02',
  url: '/firmware/test.uf2',
  size: 4,
  sha256: 'a'.repeat(64),
  published: true,
  ...over,
});

// ---------------------------------------------------------------------------
// UF2
// ---------------------------------------------------------------------------

describe('UF2 parse, family and range checks', () => {
  it('parses an image and finds its target name', () => {
    const img = parseUf2(makeUf2({pages: 40, name: MINI.target}), uf2Opts);
    assert.equal(img.pages.length, 40);
    assert.equal(img.start, 0x10000000);
    assert.equal(img.end, 0x10000000 + 40 * 256);
    assert.ok(imageContainsAscii(img, MINI.target));
    assert.ok(!imageContainsAscii(img, LITE.target));
    assert.equal(sectorsOf(img).size, 3);
  });
  it('skips the ABSOLUTE erratum block, numbered on its own or inside the run', () => {
    const own = parseUf2(makeUf2({pages: 10, name: MINI.target, absolute: true}), uf2Opts);
    assert.equal(own.ignoredBlocks, 1);
    const f = makeUf2({pages: 10, name: MINI.target, absolute: true});
    const v = new DataView(f.buffer);
    v.setUint32(20, 0, true);
    v.setUint32(24, 11, true);
    for (let i = 1; i <= 10; i++) {
      v.setUint32(i * 512 + 20, i, true);
      v.setUint32(i * 512 + 24, 11, true);
    }
    assert.equal(parseUf2(f, uf2Opts).pages.length, 10);
    assert.throws(() => parseUf2(f.slice(0, 512 * 10), uf2Opts), /truncated/);
  });
  it('rejects RISC-V, RP2040 and other families', () => {
    assert.throws(() => parseUf2(makeUf2({pages: 4, name: 'x', family: UF2_FAMILY.RP2350_RISCV}), uf2Opts), Uf2Error);
    assert.throws(() => parseUf2(makeUf2({pages: 4, name: 'x', family: UF2_FAMILY.RP2040}), uf2Opts), /family/);
  });
  it('rejects a truncated file and a partial block', () => {
    const f = makeUf2({pages: 20, name: 'x'});
    assert.throws(() => parseUf2(f.slice(0, 512 * 10), uf2Opts), /truncated/);
    assert.throws(() => parseUf2(f.slice(0, 700), uf2Opts), /512-byte/);
  });
  it('rejects addresses outside the board flash', () => {
    assert.throws(() => parseUf2(makeUf2({pages: 20, name: 'x'}), {...uf2Opts, flashSize: 4096}), /outside/);
    assert.throws(() => parseUf2(makeUf2({pages: 2, name: 'x', addrBase: 0x20000000}), uf2Opts), /outside/);
  });
  it('rejects a bad magic and a duplicate address', () => {
    const bad = makeUf2({pages: 4, name: 'x'});
    bad[512 * 3] = 0;
    assert.throws(() => parseUf2(bad, uf2Opts), /magic/);
    const dup = makeUf2({pages: 4, name: 'x'});
    new DataView(dup.buffer).setUint32(512 + 12, 0x10000000, true);
    assert.throws(() => parseUf2(dup, uf2Opts), /twice/);
  });
  it('reads INFO_UF2.TXT', () => {
    const info = parseInfoUf2('UF2 Bootloader v1.0\r\nModel: Raspberry Pi RP2350\r\nBoard-ID: RP2350\r\n');
    assert.equal(info.boardId, 'RP2350');
  });
  // R3: real Betaflight UF2s. Set FLASHER_REAL_UF2_DIR to a folder holding the
  // release .uf2 files (named with their target) to run this; skipped otherwise.
  const realDir = process.env.FLASHER_REAL_UF2_DIR;
  it('parses the real Betaflight release UF2s', {skip: !realDir}, () => {
    const files = readdirSync(realDir!).filter((n) => n.endsWith('.uf2'));
    assert.ok(files.length > 0);
    for (const f of files) {
      const t = FLASHER_TARGETS.find((x) => f.includes(x.target))!;
      const img = parseUf2(new Uint8Array(readFileSync(join(realDir!, f))), uf2Opts);
      assert.equal(img.start, 0x10000000, f);
      assert.ok(imageContainsAscii(img, t.target), f);
      for (const o of FLASHER_TARGETS) if (o !== t) assert.ok(!imageContainsAscii(img, o.target), f);
    }
  });
});

// ---------------------------------------------------------------------------
// Manifest and hashes
// ---------------------------------------------------------------------------

describe('pinned manifest and hash verification', () => {
  it('every entry resolves to an allowlisted target of the right kind', () => {
    for (const r of FIRMWARE_MANIFEST) assert.doesNotThrow(() => resolveRelease(r), r.target);
    assert.throws(() => resolveRelease(published({target: 'SOME_OTHER_BOARD'})), ManifestError);
    assert.throws(() => resolveRelease(published({kind: 'am32-hex'})), /flight controller/);
    assert.throws(() => resolveRelease(published({target: ESC20.target})), /ESC/);
  });
  it('published entries are complete and same-origin; unpublished ones are placeholders', () => {
    for (const r of FIRMWARE_MANIFEST) {
      if (r.published) assert.ok(isPublished(r), `${r.target} is marked published but incomplete`);
      else assert.ok(!isPublished(r));
    }
  });
  it('a placeholder never passes, even with a matching size', async () => {
    const ph = published({sha256: PLACEHOLDER_SHA256, published: false, url: null, size: 4});
    await assert.rejects(verifyFirmwareBytes(ph, new Uint8Array(4)), FirmwareNotPublishedError);
    await assert.rejects(verifyFirmwareBytes({...ph, published: true}, new Uint8Array(4)), FirmwareNotPublishedError);
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return new Response(new Uint8Array(4));
    }) as unknown as typeof fetch;
    await assert.rejects(fetchVerifiedFirmware(ph, 'https://opendrone.be/flash', spy), /not published yet/);
    assert.equal(fetched, false, 'placeholder must not be fetched');
    for (const r of FIRMWARE_MANIFEST.filter((x) => !x.published)) {
      await assert.rejects(verifyFirmwareBytes(r, new Uint8Array(r.size || 1)), FirmwareNotPublishedError);
    }
  });
  it('a published entry with a real hash is not published until the flag is set', async () => {
    const bytes = new TextEncoder().encode('firmware');
    const r = published({size: bytes.length, sha256: await sha256Hex(bytes), published: false});
    await assert.rejects(verifyFirmwareBytes(r, bytes), FirmwareNotPublishedError);
    assert.equal(await verifyFirmwareBytes({...r, published: true}, bytes), r.sha256);
  });
  it('rejects a modified file, a wrong size, and a cross-origin URL', async () => {
    const bytes = new TextEncoder().encode('firmware');
    const r = published({size: bytes.length, sha256: await sha256Hex(bytes)});
    const bad = bytes.slice();
    bad[0] ^= 1;
    await assert.rejects(verifyFirmwareBytes(r, bad), /checksum/);
    await assert.rejects(verifyFirmwareBytes(r, bytes.slice(1)), /size/);
    const fake = (async () => new Response(bytes.slice().buffer as ArrayBuffer)) as unknown as typeof fetch;
    assert.equal((await fetchVerifiedFirmware(r, 'https://opendrone.be/flash', fake)).sha256, r.sha256);
    assert.ok(!isPublished({...r, url: 'https://evil.example/x.uf2'}));
    assert.ok(!isPublished({...r, url: '//evil.example/x.uf2'}));
  });
  it('uppercase or short hashes are placeholders', () => {
    assert.ok(!isPublished(published({sha256: 'A'.repeat(64)})));
    assert.ok(!isPublished(published({sha256: 'a'.repeat(63)})));
  });
});

// ---------------------------------------------------------------------------
// Target matching
// ---------------------------------------------------------------------------

describe('target matching', () => {
  const report = (boardName: string, manufacturerId = 'OPFC') => ({boardName, targetName: 'RP2350A', manufacturerId});
  it('passes when chosen board, manifest, image and MSP agree', () => {
    assert.deepEqual(
      fcTargetProblems({chosen: MINI, manifestTarget: MINI.target, imageNames: [MINI.target], reported: report(MINI.target)}),
      [],
    );
  });
  it('blocks a manifest entry for another board', () => {
    assert.equal(fcTargetProblems({chosen: MINI, manifestTarget: LITE.target}).length, 1);
  });
  it('blocks an image without the target name, or naming another board', () => {
    assert.match(fcTargetProblems({chosen: MINI, imageNames: []})[0]!, /does not contain/);
    assert.match(fcTargetProblems({chosen: MINI, imageNames: [MINI.target, LITE.target]})[0]!, /names OPENFC_LITE_RP2350B/);
    assert.equal(fcTargetProblems({chosen: MINI, imageNames: [LITE.target]}).length, 2);
  });
  it('blocks an MSP report for another board, an unknown board, or another manufacturer', () => {
    assert.match(fcTargetProblems({chosen: MINI, reported: report(LITE.target)})[0]!, /reports OPENFC_LITE_RP2350B/);
    assert.match(fcTargetProblems({chosen: MINI, reported: report('SOME_BOARD')})[0]!, /not OPENFC_LITE_MINI/);
    assert.ok(fcTargetProblems({chosen: MINI, reported: report(MINI.target, 'XXXX')}).length >= 1);
  });
  it('ESC: blocks image, MCU and firmware-name mismatches', () => {
    assert.deepEqual(
      escTargetProblems({
        chosen: ESC20,
        manifestTarget: ESC20.target,
        imageNames: [ESC20.firmwareName],
        escMcu: {status: 'ok', value: 'AT32F421'},
        escFirmwareName: {status: 'ok', value: ESC20.firmwareName},
      }),
      [],
    );
    assert.equal(escTargetProblems({chosen: ESC20, manifestTarget: 'OTHER'}).length, 1);
    assert.equal(escTargetProblems({chosen: ESC20, imageNames: []}).length, 1);
    assert.equal(escTargetProblems({chosen: ESC20, escFirmwareName: {status: 'ok', value: 'OpenESC_30'}}).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Write gates (fail closed, no override)
// ---------------------------------------------------------------------------

describe('FC direct-write gate', () => {
  const allOn = {CHIP_PACKAGE_VERIFIED: true, PICOBOOT_WRITE_VERIFIED: true};
  const good = (over: Partial<FcDirectWriteInput> = {}): FcDirectWriteInput => ({
    gates: allOn,
    chosen: MINI,
    release: published(),
    verifiedFor: MINI.target,
    imageStart: 0x10000000,
    imageEnd: 0x10000000 + 900 * 1024,
    chipPackage: {status: 'ok', value: 'QFN60'},
    flashBytes: 2 * 1024 * 1024,
    installed: [MINI.target],
    ...over,
  });
  it('shipped flags are false, so the shipped gate never allows a direct write', () => {
    assert.equal(CHIP_PACKAGE_VERIFIED, false);
    assert.equal(PICOBOOT_WRITE_VERIFIED, false);
    const g = fcDirectWriteGate(good({gates: undefined}));
    assert.equal(g.allowed, false);
    assert.equal(fcDirectWriteGate(good({gates: FC_GATES})).allowed, false);
  });
  it('allows only when everything holds and both flags are true', () => {
    assert.deepEqual(fcDirectWriteGate(good()), {allowed: true, reasons: []});
  });
  it('blocks with either flag false', () => {
    assert.match(fcDirectWriteGate(good({gates: {...allOn, CHIP_PACKAGE_VERIFIED: false}})).reasons.join(), /CHIP_PACKAGE_VERIFIED/);
    assert.match(fcDirectWriteGate(good({gates: {...allOn, PICOBOOT_WRITE_VERIFIED: false}})).reasons.join(), /PICOBOOT_WRITE_VERIFIED/);
  });
  it('blocks an unread, unreadable, unknown or mismatched chip package', () => {
    assert.equal(fcDirectWriteGate(good({chipPackage: null})).allowed, false);
    assert.equal(fcDirectWriteGate(good({chipPackage: {status: 'unreadable', detail: 'x'}})).allowed, false);
    assert.equal(fcDirectWriteGate(good({chipPackage: {status: 'unknown', detail: 'x'}})).allowed, false);
    assert.equal(fcDirectWriteGate(good({chipPackage: {status: 'ok', value: 'QFN80'}})).allowed, false);
  });
  it('blocks a blank board, another board firmware, and an unscanned board', () => {
    assert.equal(fcDirectWriteGate(good({installed: []})).allowed, false);
    assert.equal(fcDirectWriteGate(good({installed: [LITE.target]})).allowed, false);
    assert.equal(fcDirectWriteGate(good({installed: [MINI.target, LITE.target]})).allowed, false);
    assert.equal(fcDirectWriteGate(good({installed: null})).allowed, false);
  });
  it('R1: blocks a verified image prepared for another board', () => {
    assert.equal(fcDirectWriteGate(good({verifiedFor: LITE.target})).allowed, false);
    assert.equal(fcDirectWriteGate(good({verifiedFor: null})).allowed, false);
    assert.equal(fcDirectWriteGate(good({release: published({target: LITE.target})})).allowed, false);
  });
  it('blocks an unpublished release and an image larger than the flash', () => {
    assert.equal(fcDirectWriteGate(good({release: published({published: false})})).allowed, false);
    assert.equal(fcDirectWriteGate(good({flashBytes: 512 * 1024})).allowed, false);
  });
});

describe('ESC direct-write gate', () => {
  const allOn: Am32Gates = {
    AM32_LAYOUT_VERIFIED: true,
    AM32_SIGNATURE_VERIFIED: true,
    AM32_EEPROM_LAYOUT_VERIFIED: true,
    AM32_WRITE_PROCEDURE_VERIFIED: true,
  };
  const good = (over: Partial<EscDirectWriteInput> = {}): EscDirectWriteInput => ({
    gates: allOn,
    chosen: ESC20,
    release: published({target: ESC20.target, kind: 'am32-hex'}),
    verifiedFor: ESC20.target,
    mcu: {status: 'ok', value: 'AT32F421'},
    firmwareName: {status: 'ok', value: ESC20.firmwareName},
    ...over,
  });
  it('shipped AM32 flags are all false and block', () => {
    for (const v of Object.values(AM32_GATES)) assert.equal(v, false);
    assert.equal(escDirectWriteGate(good({gates: undefined})).allowed, false);
  });
  it('allows only when every flag is true and both identities match', () => {
    assert.deepEqual(escDirectWriteGate(good()), {allowed: true, reasons: []});
  });
  it('any single flag false blocks', () => {
    for (const k of Object.keys(allOn) as (keyof Am32Gates)[]) {
      const g = escDirectWriteGate(good({gates: {...allOn, [k]: false}}));
      assert.equal(g.allowed, false, k);
      assert.match(g.reasons.join(), new RegExp(k));
    }
  });
  it('MCU: unread, unreadable, unknown or mismatched blocks', () => {
    assert.equal(escDirectWriteGate(good({mcu: null})).allowed, false);
    assert.equal(escDirectWriteGate(good({mcu: {status: 'unreadable', detail: 'timeout'}})).allowed, false);
    assert.equal(escDirectWriteGate(good({mcu: {status: 'unknown', detail: 'sig 0x1234'}})).allowed, false);
    assert.equal(
      escDirectWriteGate(good({mcu: {status: 'ok', value: 'STM32F051' as unknown as 'AT32F421'}})).allowed,
      false,
    );
  });
  it('target ID: unread, unreadable, blank or mismatched blocks', () => {
    assert.equal(escDirectWriteGate(good({firmwareName: null})).allowed, false);
    assert.equal(escDirectWriteGate(good({firmwareName: {status: 'unreadable', detail: 'x'}})).allowed, false);
    assert.equal(escDirectWriteGate(good({firmwareName: {status: 'blank', detail: 'x'}})).allowed, false);
    assert.equal(escDirectWriteGate(good({firmwareName: {status: 'ok', value: 'OpenESC_30'}})).allowed, false);
  });
  it('unpublished release and image for another ESC block', () => {
    assert.equal(escDirectWriteGate(good({release: published({target: ESC20.target, kind: 'am32-hex', published: false})})).allowed, false);
    assert.equal(escDirectWriteGate(good({verifiedFor: 'OTHER'})).allowed, false);
  });
});

// ---------------------------------------------------------------------------
// MSP and 4-way framing
// ---------------------------------------------------------------------------

describe('MSP v1 framing', () => {
  it('encodes with XOR checksum and decodes past noise', () => {
    assert.deepEqual([...encodeMspV1(4)], [0x24, 0x4d, 0x3c, 0, 4, 4]);
    const frame = encodeMspV1(4, Uint8Array.of(1, 2, 3));
    frame[2] = 0x3e;
    const buf = new Uint8Array([0x00, 0x24, 0x10, ...frame]);
    assert.deepEqual([...decodeMspV1(buf, 4)!.payload], [1, 2, 3]);
  });
  it('skips a frame with a bad checksum and returns null for a partial one', () => {
    const frame = encodeMspV1(MSP.SET_PASSTHROUGH, Uint8Array.of(4));
    frame[2] = 0x3e;
    const bad = frame.slice();
    bad[bad.length - 1] ^= 0xff;
    assert.equal(decodeMspV1(bad, MSP.SET_PASSTHROUGH), null);
    assert.equal(decodeMspV1(frame.slice(0, 5), MSP.SET_PASSTHROUGH), null);
  });
  it('parses BOARD_INFO', () => {
    const enc = new TextEncoder();
    const s = (x: string) => [x.length, ...enc.encode(x)];
    const p = Uint8Array.from([...enc.encode('OPFC'), 0, 0, 2, 0, ...s('RP2350A'), ...s(MINI.target), ...s('OPFC')]);
    assert.equal(parseBoardInfo(p).boardName, MINI.target);
  });
});

describe('4-way framing and CRC', () => {
  it('CRC-16/XMODEM check value', () => {
    assert.equal(crc16Xmodem(new TextEncoder().encode('123456789')), 0x31c3);
  });
  it('encodes a request, padding an empty parameter list to one byte', () => {
    const f = encodeFourWay(FOURWAY_CMD.InterfaceTestAlive, 0);
    assert.deepEqual([...f.subarray(0, 6)], [0x2f, 0x30, 0, 0, 1, 0]);
    const crc = crc16Xmodem(f.subarray(0, 6));
    assert.deepEqual([...f.subarray(6)], [crc >> 8, crc & 0xff]);
    assert.throws(() => encodeFourWay(0x3a, 0x10000));
  });
  it('decodes a response after an echo, rejects bad CRC, handles len 0 = 256', () => {
    const resp = (cmd: number, addr: number, params: Uint8Array, ack = 0) => {
      const body = Uint8Array.from([0x2e, cmd, addr >> 8, addr & 0xff, params.length & 0xff, ...params, ack]);
      const crc = crc16Xmodem(body);
      return Uint8Array.from([...body, crc >> 8, crc & 0xff]);
    };
    const echo = encodeFourWay(0x3a, 0x1000, Uint8Array.of(16));
    const r = resp(0x3a, 0x1000, new Uint8Array(16).fill(9));
    const hit = decodeFourWay(Uint8Array.from([...echo, ...r]), 0x3a)!;
    assert.equal(hit.value.address, 0x1000);
    assert.equal(hit.value.params.length, 16);
    assert.equal(hit.consumed, echo.length + r.length);
    const bad = r.slice();
    bad[8] ^= 1;
    assert.equal(decodeFourWay(bad, 0x3a), null);
    const big = resp(0x3a, 0, new Uint8Array(256).fill(1));
    assert.equal(decodeFourWay(big, 0x3a)!.value.params.length, 256);
  });
  it('parses device info', () => {
    const d = parseDeviceInfo(Uint8Array.of(0x06, 0x47, 0x00, FOURWAY_MODE_ARM_BLB));
    assert.equal(d.signature, AM32_SIGNATURE_AT32F421);
    assert.equal(classifyMcu(d).status, 'ok');
    assert.equal(classifyMcu({...d, signature: 0x1234}).status, 'unknown');
    assert.equal(classifyMcu({...d, signature: 0xffff}).status, 'unreadable');
    assert.equal(classifyMcu({...d, interfaceMode: 1}).status, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// Intel HEX and the AM32 address guard
// ---------------------------------------------------------------------------

describe('Intel HEX', () => {
  it('parses data with a linear address and rejects checksum errors', () => {
    const text = makeHex(0x08001000, Uint8Array.of(1, 2, 3, 4));
    const img = parseIntelHex(text);
    assert.equal(img.start, 0x08001000);
    assert.equal(img.end, 0x08001004);
    assert.throws(() => parseIntelHex(text.replace(':04100000', ':04100001')), IntelHexError);
    assert.throws(() => parseIntelHex(text.split('\r\n').slice(0, -2).join('\n')), /end-of-file/);
  });
});

describe('AM32 address guard', () => {
  it('rejects any write into the bootloader region', () => {
    assert.throws(() => assertAm32Writable(0, 256), Am32AddressError);
    assert.throws(() => assertAm32Writable(0x0f00, 256), /bootloader/);
    assert.throws(() => assertAm32Writable(AM32_APP_START - 1, 2), /bootloader/);
  });
  it('rejects the EEPROM page and anything past the app area', () => {
    assert.throws(() => assertAm32Writable(AM32_EEPROM_OFFSET, 16), /EEPROM/);
    assert.throws(() => assertAm32Writable(AM32_EEPROM_OFFSET - 8, 16), /EEPROM/);
    assert.throws(() => assertAm32Writable(0x8000, 256), Am32AddressError);
    assert.throws(() => assertAm32Writable(AM32_APP_START, 0), Am32AddressError);
  });
  it('accepts the app area', () => {
    assert.doesNotThrow(() => assertAm32Writable(AM32_APP_START, 256));
    assert.doesNotThrow(() => assertAm32Writable(AM32_EEPROM_OFFSET - 256, 256));
  });
  it('prepareAm32Image refuses a hex that touches the bootloader or EEPROM', () => {
    const app = makeAm32App();
    assert.throws(() => prepareAm32Image(makeHex(AT32F421_FLASH_BASE, app), ESC20), Am32AddressError);
    assert.throws(() => prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_EEPROM_OFFSET - 512, app), ESC20), Am32AddressError);
  });
  it('prepareAm32Image checks the embedded firmware name', () => {
    const img = prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_APP_START, makeAm32App()), ESC20);
    assert.equal(img.pages.length, 3);
    assert.equal(img.pages[0]!.offset, AM32_APP_START);
    assert.throws(() => prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_APP_START, makeAm32App('SomeOther   ')), ESC20), /firmware name/);
  });
  it('reads the EEPROM firmware name: ok, blank, not text', () => {
    const e = new Uint8Array(32).fill(0xff);
    assert.equal(parseEepromFirmwareName(e).status, 'blank');
    e.set(new TextEncoder().encode('OpenESC_20  '), AM32_EEPROM_NAME_INDEX);
    assert.deepEqual(parseEepromFirmwareName(e), {status: 'ok', value: 'OpenESC_20'});
    e[AM32_EEPROM_NAME_INDEX] = 0x01;
    assert.equal(parseEepromFirmwareName(e).status, 'unreadable');
    assert.equal(parseEepromFirmwareName(new Uint8Array(4)).status, 'unreadable');
  });
});

// ---------------------------------------------------------------------------
// AM32 write procedure against a simulated 4-way ESC
// ---------------------------------------------------------------------------

/** Simulated AM32 bootloader behind a 4-way interface. Records every erase/write offset. */
class FakeEsc implements ByteLink {
  flash = new Uint8Array(0x8000).fill(0xff);
  writes: number[] = [];
  erases: number[] = [];
  sig = AM32_SIGNATURE_AT32F421;
  dead = false;
  private out = new Uint8Array(0);
  constructor(name: string | null) {
    this.flash.fill(0x11, 0, 0x1000); // bootloader
    if (name !== null) {
      this.flash.set([0x01, 0x02, 0x0e, 0x02, 0x10], AM32_EEPROM_OFFSET);
      this.flash.set(new TextEncoder().encode(name.padEnd(12, ' ')), AM32_EEPROM_OFFSET + AM32_EEPROM_NAME_INDEX);
    }
  }
  flush(): void {}
  async write(req: Uint8Array): Promise<void> {
    const cmd = req[1]!;
    const addr = (req[2]! << 8) | req[3]!;
    const len = req[4] || 256;
    const params = req.subarray(5, 5 + len);
    let reply: Uint8Array = Uint8Array.of(0);
    if (this.dead) return;
    switch (cmd) {
      case FOURWAY_CMD.DeviceInitFlash:
        reply = Uint8Array.of(this.sig & 0xff, this.sig >> 8, 0, FOURWAY_MODE_ARM_BLB);
        break;
      case FOURWAY_CMD.DeviceRead: {
        const n = params[0] || 256;
        reply = this.flash.slice(addr, addr + n);
        break;
      }
      case FOURWAY_CMD.DevicePageErase:
        this.erases.push(params[0]! * AM32_PAGE_SIZE);
        this.flash.fill(0xff, params[0]! * AM32_PAGE_SIZE, (params[0]! + 1) * AM32_PAGE_SIZE);
        break;
      case FOURWAY_CMD.DeviceWrite:
        this.writes.push(addr);
        this.flash.set(params, addr);
        break;
    }
    const body = Uint8Array.from([0x2e, cmd, addr >> 8, addr & 0xff, reply.length & 0xff, ...reply, 0]);
    const crc = crc16Xmodem(body);
    this.out = Uint8Array.from([...this.out, ...body, crc >> 8, crc & 0xff]);
  }
  async readFrame<T>(decode: (buf: Uint8Array) => Decoded<T>): Promise<T> {
    const hit = decode(this.out);
    if (!hit) throw new Error('no reply');
    this.out = this.out.slice(hit.consumed);
    return hit.value;
  }
}

describe('AM32 write procedure (simulated ESC)', () => {
  const allOn: Am32Gates = {
    AM32_LAYOUT_VERIFIED: true,
    AM32_SIGNATURE_VERIFIED: true,
    AM32_EEPROM_LAYOUT_VERIFIED: true,
    AM32_WRITE_PROCEDURE_VERIFIED: true,
  };
  const release = published({target: ESC20.target, kind: 'am32-hex'});
  const image = () => prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_APP_START, makeAm32App()), ESC20);
  const noop = () => {};

  it('identifies MCU and firmware name read-only', async () => {
    const esc = new FakeEsc('OpenESC_20');
    const id = await identifyEsc(new FourWay(esc), 0);
    assert.deepEqual(id.mcu, {status: 'ok', value: 'AT32F421'});
    assert.deepEqual(id.firmwareName, {status: 'ok', value: 'OpenESC_20'});
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('an unresponsive ESC is unreadable, not an error', async () => {
    const esc = new FakeEsc('OpenESC_20');
    esc.dead = true;
    const id = await identifyEsc(new FourWay(esc), 0);
    assert.equal(id.mcu.status, 'unreadable');
    assert.equal(id.firmwareName.status, 'unreadable');
  });
  it('with the shipped flags it refuses before touching flash', async () => {
    const esc = new FakeEsc('OpenESC_20');
    await assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop), Am32Error);
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('refuses a blank, mismatched or unknown ESC even with all flags on', async () => {
    for (const esc of [new FakeEsc(null), new FakeEsc('OpenESC_30')]) {
      await assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn), /Not writing/);
      assert.equal(esc.writes.length + esc.erases.length, 0);
    }
    const other = new FakeEsc('OpenESC_20');
    other.sig = 0x1234;
    await assert.rejects(flashAm32(new FourWay(other), 0, image(), ESC20, release, noop, allOn), /Not writing/);
    assert.equal(other.writes.length, 0);
  });
  it('with all flags on: first page erased first and written last, bootloader and EEPROM untouched', async () => {
    const esc = new FakeEsc('OpenESC_20');
    const bootBefore = esc.flash.slice(0, 0x1000);
    const eepromBefore = esc.flash.slice(AM32_EEPROM_OFFSET, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE);
    const img = image();
    await flashAm32(new FourWay(esc), 0, img, ESC20, release, noop, allOn);
    assert.equal(esc.erases[0], AM32_APP_START);
    assert.equal(esc.writes[esc.writes.length - 4], AM32_APP_START);
    for (const a of [...esc.writes, ...esc.erases]) assert.ok(a >= AM32_APP_START && a < AM32_EEPROM_OFFSET);
    assert.deepEqual(esc.flash.slice(0, 0x1000), bootBefore);
    assert.deepEqual(esc.flash.slice(AM32_EEPROM_OFFSET, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE), eepromBefore);
    for (const p of img.pages) assert.deepEqual(esc.flash.slice(p.offset, p.offset + p.data.length), p.data);
  });
});
