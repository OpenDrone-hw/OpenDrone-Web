import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {
  AM32_APP_START,
  AM32_EEPROM_DEFAULTS_SIZE,
  AM32_EEPROM_OFFSET,
  AM32_GATES,
  AM32_NAME_SLOT_OFFSET,
  AM32_NAME_SLOT_SIZE,
  AM32_PAGE_SIZE,
  AM32_SIGNATURE_AT32F421,
  AM32_TEST_SEAM_ENV,
  AM32_TEST_SEAM_VALUE,
  AT32F421_FLASH_BASE,
  Am32AddressError,
  Am32WriteDisabledError,
  FOURWAY_MODE_ARM_BLB,
  am32WritesEnabled,
  assertAm32EepromPageErasable,
  assertAm32EepromWritable,
  assertAm32Writable,
  type Am32Gates,
} from './am32-layout.ts';
import {Am32FinalVerifyError, classifyMcu, flashAm32, identifyEsc, parseAm32NameSlot, prepareAm32Image} from './am32.ts';
import {FIRMWARE_MANIFEST, PINNED, pinToRelease, type FirmwarePin} from './firmware-manifest.ts';
import {ACK_TEXT, FOURWAY_CMD, FourWay, crc16Xmodem, decodeFourWay, encodeFourWay, parseDeviceInfo} from './fourway.ts';
import {
  FC_GATES,
  escDirectWriteGate,
  escTargetProblems,
  fcDirectWriteGate,
  fcInstallEnabled,
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
  isAllowedFirmwareUrl,
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

/**
 * SYNTHETIC AM32 name slot (32 bytes): name, NUL terminator, NUL padding. Mirrors
 * the documented AM32 F421 layout (am32-layout.ts); no bytes from any real image.
 */
function nameSlot(name: string): Uint8Array {
  const slot = new Uint8Array(AM32_NAME_SLOT_SIZE); // 0x00 padding
  slot.set(new TextEncoder().encode(name), 0);
  return slot;
}

/**
 * A SYNTHETIC AM32-like app image in the QC-image layout: app from 0x08001000
 * up to the EEPROM page (27 KB), non-text filler, and the name slot at flash
 * 0x08007BE0 (app offset 0x6BE0). `slot` overrides the 32 slot bytes.
 */
function makeAm32App(name = 'OPENESC_20_F421', slot: Uint8Array = nameSlot(name)): Uint8Array {
  const size = AM32_EEPROM_OFFSET - AM32_APP_START;
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = ((i * 7 + 1) & 0x7f) | 0x80; // never ASCII
  b.set(slot, AM32_NAME_SLOT_OFFSET - AM32_APP_START);
  return b;
}

/** SYNTHETIC EEPROM v4 defaults blob: 192 bytes, byte 1 = layout version 4. No bytes from any real image. */
function makeEepromDefaults(): Uint8Array {
  const b = new Uint8Array(AM32_EEPROM_DEFAULTS_SIZE);
  for (let i = 0; i < b.length; i++) b[i] = (i * 13 + 5) & 0xff;
  b[1] = 4;
  return b;
}

const TEST_RELEASE_URL = 'https://github.com/OpenDrone-hw/OpenFC-Lite-Mini/releases/download/v0.0.0-test/test.uf2';

const published = (over: Partial<FirmwareRelease> = {}): FirmwareRelease => ({
  target: MINI.target,
  kind: 'betaflight-uf2',
  version: 'test',
  firmware: 'test',
  channel: 'stable',
  released: '2026-11-02',
  url: TEST_RELEASE_URL,
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
    assert.ok(!isPublished({...r, url: '/firmware/test.uf2'}), 'same-origin paths are not on the allowlist');
  });
  it('F11: alpha builds are channel alpha, never stable', () => {
    for (const r of FIRMWARE_MANIFEST) {
      if (/alpha/i.test(r.firmware) || /alpha/i.test(r.version)) assert.equal(r.channel, 'alpha', r.target);
    }
  });
  it('uppercase or short hashes are placeholders', () => {
    assert.ok(!isPublished(published({sha256: 'A'.repeat(64)})));
    assert.ok(!isPublished(published({sha256: 'a'.repeat(63)})));
  });
});

describe('PINNED release assets (one line per board)', () => {
  const goodPin: FirmwarePin = {
    version: 'v1.0.0',
    url: 'https://github.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/AM32_OPENESC_20_F421_2.21.hex',
    sha256: 'ab'.repeat(32),
    size: 76543,
    channel: 'stable',
  };
  it('ships with every board unpinned, so nothing is offered', () => {
    for (const v of Object.values(PINNED)) assert.equal(v, null);
    assert.equal(FIRMWARE_MANIFEST.length, Object.keys(PINNED).length);
    for (const r of FIRMWARE_MANIFEST) assert.ok(!isPublished(r), r.target);
    for (const t of ['OPENFC_LITE_RP2350B', 'OPENFC_LITE_MINI_RP2350A'] as const) {
      const r = FIRMWARE_MANIFEST.find((x) => x.target === t)!;
      assert.equal(r.published, false);
      assert.equal(r.channel, 'alpha', 'FC builds stay labelled alpha');
    }
  });
  it('a null pin is blocked as not published and never fetched', async () => {
    const r = pinToRelease('OPENESC_20_F421', null);
    assert.equal(r.published, false);
    assert.ok(!isPublished(r));
    await assert.rejects(verifyFirmwareBytes(r, new Uint8Array(1)), FirmwareNotPublishedError);
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return new Response(new Uint8Array(1));
    }) as unknown as typeof fetch;
    await assert.rejects(fetchVerifiedFirmware(r, 'https://opendrone.be/flash', spy), /not published yet/);
    assert.equal(fetched, false);
  });
  it('a complete pin passes structural validation', () => {
    const r = pinToRelease('OPENESC_20_F421', goodPin);
    assert.ok(isPublished(r));
    assert.equal(r.kind, 'am32-hex');
    assert.doesNotThrow(() => resolveRelease(r));
  });
  it('a malformed pin is blocked', () => {
    const bad: Partial<FirmwarePin>[] = [
      {sha256: 'AB'.repeat(32)},
      {sha256: 'ab'.repeat(31)},
      {sha256: 'zz'.repeat(32)},
      {size: 0},
      {size: -1},
      {size: 1.5},
      {size: 5 * 1024 * 1024},
      {version: ''},
      {version: '   '},
      {url: ''},
      {channel: 'nightly' as FirmwarePin['channel']},
    ];
    for (const over of bad) {
      assert.ok(!isPublished(pinToRelease('OPENESC_20_F421', {...goodPin, ...over})), JSON.stringify(over));
    }
  });
  it('a non-allowlisted URL is blocked', () => {
    const urls = [
      'http://github.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://evil.example/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://github.com.evil.example/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://github.com/someone-else/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://github.com/OpenDrone-hw/OpenESC-20x20/raw/main/firmware/a.hex',
      'https://github.com/OpenDrone-hw/OpenESC-20x20/blob/main/a.hex',
      'https://raw.githubusercontent.com/OpenDrone-hw/OpenESC-20x20/main/a.hex',
      'https://objects.githubusercontent.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://github.com:8443/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://user@github.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      'https://github.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex?x=1',
      'https://github.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex#f',
      'https://github.com/OpenDrone-hw/x/releases/download/../../../evil/a.hex',
      'https://GITHUB.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
      '/firmware/openfc/a.uf2',
      '//github.com/OpenDrone-hw/OpenESC-20x20/releases/download/v1.0.0/a.hex',
    ];
    assert.ok(isAllowedFirmwareUrl(goodPin.url));
    for (const url of urls) {
      assert.ok(!isAllowedFirmwareUrl(url), url);
      assert.ok(!isPublished(pinToRelease('OPENESC_20_F421', {...goodPin, url})), url);
    }
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
    assert.equal(escTargetProblems({chosen: ESC20, escFirmwareName: {status: 'ok', value: 'OpenESC_20'}}).length, 1);
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
  it('F3: Install stays disabled while connecting, even with an allowed gate from the previous board', () => {
    const ok = {gate: {allowed: true, reasons: []}, connected: true, connecting: false, battery: true, flashing: false, finished: false};
    assert.equal(fcInstallEnabled(ok), true);
    assert.equal(fcInstallEnabled({...ok, connecting: true}), false);
    assert.equal(fcInstallEnabled({...ok, connected: false}), false);
    assert.equal(fcInstallEnabled({...ok, battery: false}), false);
    assert.equal(fcInstallEnabled({...ok, gate: {allowed: false, reasons: ['x']}}), false);
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
  it('F8: ACK codes match the 4-way interface', () => {
    assert.equal(ACK_TEXT[0x08], 'invalid ESC number');
    assert.equal(ACK_TEXT[0x09], 'invalid parameter');
    assert.equal(ACK_TEXT[0x0b], undefined);
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
  it('prepareAm32Image checks the name slot of the pinned image at 0x08007BE0', () => {
    const at = (app: Uint8Array) => makeHex(AT32F421_FLASH_BASE + AM32_APP_START, app);
    const img = prepareAm32Image(at(makeAm32App()), ESC20);
    assert.equal(img.pages.length, 27);
    assert.equal(img.pages[0]!.offset, AM32_APP_START);
    assert.throws(() => prepareAm32Image(at(makeAm32App('OPENESC_30_F421')), ESC20), /0x8007be0 is "OPENESC_30_F421"/);
    assert.throws(() => prepareAm32Image(at(makeAm32App('OPENESC_20_F42')), ESC20), /not OPENESC_20_F421/);
    assert.throws(() => prepareAm32Image(at(makeAm32App('', new Uint8Array(32).fill(0xff))), ESC20), /blank/);
    // Right name, but not where the bootloader-side read looks: refused.
    const elsewhere = makeAm32App('', new Uint8Array(32).fill(0xff));
    elsewhere.set(nameSlot('OPENESC_20_F421'), 0x200);
    assert.throws(() => prepareAm32Image(at(elsewhere), ESC20), /blank/);
    // Name with non-zero padding (no exact terminator/padding match): refused.
    const pad = nameSlot('OPENESC_20_F421');
    pad[20] = 0x20;
    assert.throws(() => prepareAm32Image(at(makeAm32App('', pad)), ESC20), /padding/);
    // An image that ends before the slot carries no identity: refused.
    assert.throws(() => prepareAm32Image(at(makeAm32App().subarray(0, 3 * 1024)), ESC20), /blank/);
  });
  it('F9: refuses an image that does not start exactly at the app address', () => {
    const app = makeAm32App().subarray(0, 3 * 1024);
    assert.throws(() => prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_APP_START + 4, app), ESC20), /app address/);
  });
  it('F9: pages without data inside the image are still erased and written (0xFF)', () => {
    const app = makeAm32App();
    app.fill(0xff, 1024, 2048); // second page has no meaningful data; drop it from the hex entirely
    const text = makeHex(AT32F421_FLASH_BASE + AM32_APP_START, app)
      .split('\r\n')
      .filter((l) => {
        if (!l.startsWith(':10')) return true;
        const addr = parseInt(l.slice(3, 7), 16);
        return addr < 0x1400 || addr >= 0x1800;
      })
      .join('\r\n');
    const img = prepareAm32Image(text, ESC20);
    assert.deepEqual(img.pages.slice(0, 4).map((p) => p.offset), [0x1000, 0x1400, 0x1800, 0x1c00]);
    assert.equal(img.pages.length, 27);
    assert.ok(img.pages[1]!.data.every((b) => b === 0xff));
  });
  it('identity slot is flash 0x08007BE0, 32 bytes, right before the EEPROM page', () => {
    assert.equal(AM32_NAME_SLOT_OFFSET, 0x7be0);
    assert.equal(AT32F421_FLASH_BASE + AM32_NAME_SLOT_OFFSET, 0x08007be0);
    assert.equal(AM32_NAME_SLOT_OFFSET + AM32_NAME_SLOT_SIZE, AM32_EEPROM_OFFSET);
    assert.doesNotThrow(() => assertAm32Writable(AM32_NAME_SLOT_OFFSET, AM32_NAME_SLOT_SIZE));
  });
  it('parses the name slot strictly: name + NUL terminator + NUL padding', () => {
    assert.deepEqual(parseAm32NameSlot(nameSlot('OPENESC_20_F421')), {status: 'ok', value: 'OPENESC_20_F421'});
    assert.equal(parseAm32NameSlot(new Uint8Array(32).fill(0xff)).status, 'blank');
    assert.equal(parseAm32NameSlot(new Uint8Array(32)).status, 'blank');
    assert.equal(parseAm32NameSlot(new Uint8Array(32).fill(0x41)).status, 'unreadable'); // no terminator
    const tail = nameSlot('OPENESC_20_F421');
    tail.fill(0xff, 16);
    assert.equal(parseAm32NameSlot(tail).status, 'unreadable'); // padding not 0x00
    const sp = nameSlot('OPENESC_20_F421 ');
    assert.equal(parseAm32NameSlot(sp).status, 'unreadable'); // space is not part of a name
    const ctl = nameSlot('OPENESC_20_F421');
    ctl[3] = 0x01;
    assert.equal(parseAm32NameSlot(ctl).status, 'unreadable');
    const late = new Uint8Array(32).fill(0x41);
    late[30] = 0;
    late[31] = 0;
    assert.equal(parseAm32NameSlot(late).status, 'unreadable'); // terminator outside filename[30]
    assert.equal(parseAm32NameSlot(new Uint8Array(4)).status, 'unreadable');
    assert.equal(parseAm32NameSlot(nameSlot('OPENESC_20_F421').subarray(0, 31)).status, 'unreadable');
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
  /** F4: the bootloader ACKs page erases but does nothing. */
  eraseNoop = false;
  /** Review 3 F5: a write at a 1 KB-aligned address erases its erase block first (upstream AM32 bootloader behaviour). */
  alignedWriteErases = false;
  /** Review 3 F4: erase block size (B10): 0x400, or 0x800 for a 2 KB-granularity part. */
  eraseBlock = AM32_PAGE_SIZE;
  writeLens: number[] = [];
  resets = 0;
  /** Called after every DeviceWrite (tests that damage flash behind the flasher's back). */
  afterWrite: ((addr: number) => void) | null = null;
  private eraseAt(addr: number): void {
    const start = addr - (addr % this.eraseBlock);
    this.flash.fill(0xff, start, start + this.eraseBlock);
  }
  /** F2: frames that arrive (late) right before the reply to the next request. */
  lateFrames: Uint8Array[] = [];
  flushes = 0;
  private out = new Uint8Array(0);
  /**
   * SYNTHETIC QC-layout ESC: bootloader filler at 0x0000, `name` in the name
   * slot at 0x7BE0 (null = erased app, slot 0xFF), and an EEPROM v4-style
   * header at 0x7C00 whose bytes 5..16 are settings (`eepromText` lets a test
   * put text there to prove it is never used as the identity).
   */
  constructor(name: string | null, eepromText = '') {
    this.flash.fill(0x11, 0, 0x1000); // bootloader
    this.flash.set([0x01, 0x04, 0x01, 0x02, 0x15], AM32_EEPROM_OFFSET); // v4 header, fw 2.21
    this.flash.set([0xa0, 0x04, 0x00, 0x0a, 0x64, 0x00, 0x32, 0x02, 0x00, 0x00, 0x00, 0x00], AM32_EEPROM_OFFSET + 5);
    if (eepromText) this.flash.set(new TextEncoder().encode(eepromText.slice(0, 12)), AM32_EEPROM_OFFSET + 5);
    if (name !== null) {
      this.flash.fill(0x5a, AM32_APP_START, AM32_NAME_SLOT_OFFSET);
      this.flash.set(nameSlot(name), AM32_NAME_SLOT_OFFSET);
    }
  }
  flush(): void {
    this.flushes++;
    this.out = new Uint8Array(0);
  }
  /** A complete, CRC-valid 4-way reply frame. */
  static frame(cmd: number, addr: number, reply: Uint8Array, ack = 0): Uint8Array {
    const body = Uint8Array.from([0x2e, cmd, addr >> 8, addr & 0xff, reply.length & 0xff, ...reply, ack]);
    const crc = crc16Xmodem(body);
    return Uint8Array.from([...body, crc >> 8, crc & 0xff]);
  }
  /** Bytes already in the receive buffer (arrived before the next request). */
  queue(frame: Uint8Array): void {
    this.out = Uint8Array.from([...this.out, ...frame]);
  }
  async write(req: Uint8Array): Promise<void> {
    for (const f of this.lateFrames.splice(0)) this.queue(f);
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
        if (!this.eraseNoop) this.eraseAt(params[0]! * AM32_PAGE_SIZE);
        break;
      case FOURWAY_CMD.DeviceWrite:
        this.writes.push(addr);
        this.writeLens.push(params.length);
        if (this.alignedWriteErases && addr % AM32_PAGE_SIZE === 0) this.eraseAt(addr);
        // Flash programming only clears bits: writing over unerased flash ANDs.
        for (let i = 0; i < params.length; i++) this.flash[addr + i] = (this.flash[addr + i] ?? 0xff) & params[i]!;
        this.afterWrite?.(addr);
        break;
      case FOURWAY_CMD.DeviceReset:
        this.resets++;
        break;
    }
    this.queue(FakeEsc.frame(cmd, addr, reply));
  }
  async readFrame<T>(decode: (buf: Uint8Array) => Decoded<T>): Promise<T> {
    const hit = decode(this.out);
    if (!hit) throw new Error('no reply');
    this.out = this.out.slice(hit.consumed);
    return hit.value;
  }
}

/**
 * Opens the Node-only test seam (am32-layout.ts) around `fn`, so the simulated
 * ESC can exercise the real erase/write path while every shipped
 * AM32_*_VERIFIED constant stays false. Not reachable from a browser.
 */
async function withSimulatedWrites<T>(fn: () => Promise<T>): Promise<T> {
  process.env[AM32_TEST_SEAM_ENV] = AM32_TEST_SEAM_VALUE;
  try {
    return await fn();
  } finally {
    delete process.env[AM32_TEST_SEAM_ENV];
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
  const image = () => prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_APP_START, makeAm32App()), ESC20, makeEepromDefaults());
  const noop = () => {};

  it('identifies MCU and firmware name read-only', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const id = await identifyEsc(new FourWay(esc), 0);
    assert.deepEqual(id.mcu, {status: 'ok', value: 'AT32F421'});
    assert.deepEqual(id.firmwareName, {status: 'ok', value: 'OPENESC_20_F421'});
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('QC-layout identity: OPENESC_20_F421 in the 0x7BE0 slot passes the target check', async () => {
    const id = await identifyEsc(new FourWay(new FakeEsc('OPENESC_20_F421')), 0);
    assert.deepEqual(escTargetProblems({chosen: ESC20, escMcu: id.mcu, escFirmwareName: id.firmwareName}), []);
    assert.equal(escDirectWriteGate({gates: allOn, chosen: ESC20, release, verifiedFor: ESC20.target, mcu: id.mcu, firmwareName: id.firmwareName}).allowed, true);
  });
  it('QC-layout identity: a wrong name in the slot is refused', async () => {
    for (const name of ['OPENESC_30_F421', 'OPENESC_20_F051', 'OpenESC_20', 'OPENESC_20_F42']) {
      const id = await identifyEsc(new FourWay(new FakeEsc(name)), 0);
      assert.deepEqual(id.firmwareName, {status: 'ok', value: name});
      assert.equal(escTargetProblems({chosen: ESC20, escFirmwareName: id.firmwareName}).length, 1, name);
    }
  });
  it('QC-layout identity: text in EEPROM settings bytes 5..16 is never used', async () => {
    // Blank app, but EEPROM bytes 5..16 spell the old expected name or the target: still blank, refused.
    for (const text of ['OpenESC_20  ', 'OPENESC_20_F']) {
      const id = await identifyEsc(new FourWay(new FakeEsc(null, text)), 0);
      assert.equal(id.firmwareName.status, 'blank', text);
      assert.equal(escTargetProblems({chosen: ESC20, escFirmwareName: id.firmwareName}).length, 1);
    }
    // Right slot, unrelated text in the settings: the slot decides.
    const id = await identifyEsc(new FourWay(new FakeEsc('OPENESC_20_F421', 'OPENESC_30_F')), 0);
    assert.deepEqual(id.firmwareName, {status: 'ok', value: 'OPENESC_20_F421'});
  });
  it('QC-layout identity: a blank (0xFF) or zeroed name slot is refused', async () => {
    const ff = new FakeEsc(null);
    const zero = new FakeEsc('OPENESC_20_F421');
    zero.flash.fill(0x00, AM32_NAME_SLOT_OFFSET, AM32_EEPROM_OFFSET);
    for (const esc of [ff, zero]) {
      const id = await identifyEsc(new FourWay(esc), 0);
      assert.equal(id.firmwareName.status, 'blank');
      assert.equal(escDirectWriteGate({gates: allOn, chosen: ESC20, release, verifiedFor: ESC20.target, mcu: id.mcu, firmwareName: id.firmwareName}).allowed, false);
    }
  });
  it('an unresponsive ESC is unreadable, not an error', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.dead = true;
    const id = await identifyEsc(new FourWay(esc), 0);
    assert.equal(id.mcu.status, 'unreadable');
    assert.equal(id.firmwareName.status, 'unreadable');
  });
  it('with the shipped flags it refuses before touching flash', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    await assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop), Am32WriteDisabledError);
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('F1: the shipped constants are hard-checked; an all-true gates argument cannot unlock a write', async () => {
    assert.equal(am32WritesEnabled(), false);
    const esc = new FakeEsc('OPENESC_20_F421');
    await assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn), Am32WriteDisabledError);
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('F1: the 4-way erase and write primitives refuse on their own while any flag is false', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const fw = new FourWay(esc);
    await assert.rejects(fw.pageEraseUnchecked(AM32_APP_START / AM32_PAGE_SIZE), Am32WriteDisabledError);
    await assert.rejects(fw.writeUnchecked(AM32_APP_START, new Uint8Array(16)), Am32WriteDisabledError);
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('F1: a wrong value in the seam variable does not open it', async () => {
    process.env[AM32_TEST_SEAM_ENV] = '1';
    try {
      assert.equal(am32WritesEnabled(), false);
    } finally {
      delete process.env[AM32_TEST_SEAM_ENV];
    }
  });
  it('refuses a blank, mismatched or unknown ESC even with all flags on', async () => {
    await withSimulatedWrites(async () => {
      for (const esc of [new FakeEsc(null), new FakeEsc('OPENESC_30_F421')]) {
        await assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn), /Not writing/);
        assert.equal(esc.writes.length + esc.erases.length, 0);
      }
      const other = new FakeEsc('OPENESC_20_F421');
      other.sig = 0x1234;
      await assert.rejects(flashAm32(new FourWay(other), 0, image(), ESC20, release, noop, allOn), /Not writing/);
      assert.equal(other.writes.length, 0);
    });
  });
  it('F4/F5: a bare-ACK page erase on a bootloader without implicit erase fails closed, old vector table intact', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.flash.fill(0x5a, AM32_APP_START, AM32_NAME_SLOT_OFFSET); // old app (name slot kept)
    esc.eraseNoop = true;
    const before = esc.flash.slice();
    await withSimulatedWrites(() =>
      assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn), /did not erase .*aligned-write fallback/),
    );
    // Only the F5 fallback: one aligned all-0xFF write at the first app page, which cannot set bits.
    assert.deepEqual(esc.writes, [AM32_APP_START]);
    assert.deepEqual(esc.writeLens, [256]);
    assert.deepEqual(esc.erases, [AM32_APP_START]);
    assert.deepEqual(esc.flash, before);
    assert.equal(esc.resets, 0);
  });
  it('F5: a bare-ACK page erase with the aligned-write implicit erase completes through the fallback, inside the guards', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.flash.fill(0x5a, AM32_APP_START, AM32_NAME_SLOT_OFFSET);
    esc.flash.fill(0xa5, AM32_EEPROM_OFFSET + 192, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE);
    esc.eraseNoop = true;
    esc.alignedWriteErases = true;
    const bootBefore = esc.flash.slice(0, 0x1000);
    const img = image();
    const report = await withSimulatedWrites(() => flashAm32(new FourWay(esc), 0, img, ESC20, release, noop, allOn));
    assert.equal(report.erases.length, img.pages.length + 1);
    assert.ok(report.erases.every((r) => r.path === 'aligned-write'));
    assert.equal(report.erases.at(-1)!.offset, AM32_EEPROM_OFFSET);
    for (const p of img.pages) assert.deepEqual(esc.flash.slice(p.offset, p.offset + p.data.length), p.data);
    assert.deepEqual(esc.flash.slice(AM32_EEPROM_OFFSET, AM32_EEPROM_OFFSET + 192), makeEepromDefaults());
    assert.ok(esc.flash.slice(AM32_EEPROM_OFFSET + 192, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE).every((b) => b === 0xff));
    assert.deepEqual(esc.flash.slice(0, 0x1000), bootBefore);
    esc.writes.forEach((a, i) => {
      const len = esc.writeLens[i]!;
      if (a >= AM32_EEPROM_OFFSET) assert.deepEqual([a, len], [AM32_EEPROM_OFFSET, 192], 'EEPROM writes are exactly (0x7C00, 192)');
      else assert.ok(a >= AM32_APP_START && a + len <= AM32_EEPROM_OFFSET);
    });
    assert.equal(esc.resets, 1);
  });
  it('F5: a normal page erase records the page-erase path (no fallback writes)', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const img = image();
    const report = await withSimulatedWrites(() => flashAm32(new FourWay(esc), 0, img, ESC20, release, noop, allOn));
    assert.ok(report.erases.every((r) => r.path === 'page-erase'));
    assert.equal(esc.writes.length, img.pages.length * 4 + 1);
  });
  it('F4: 2 KB erase granularity (EEPROM erase blanks the verified name-slot page) is caught by the final read-back; never "installed"', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.eraseBlock = 0x800;
    const bootBefore = esc.flash.slice(0, 0x1000);
    const err = await withSimulatedWrites(() =>
      flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn).then(
        () => assert.fail('install must fail'),
        (e: unknown) => e,
      ),
    );
    assert.ok(err instanceof Am32FinalVerifyError, String(err));
    assert.match(err.message, /Final check failed: the firmware at 0x8[0-9a-f]+ changed after it was written and checked\. The ESC is NOT installed/);
    assert.ok(esc.flash.slice(0x7800, AM32_EEPROM_OFFSET).every((b) => b === 0xff), 'name-slot page blanked after its verify (the case F4 describes)');
    assert.equal(err.disabled, true, 'first app page erased again');
    assert.ok(esc.flash.slice(AM32_APP_START, AM32_APP_START + AM32_PAGE_SIZE).every((b) => b === 0xff));
    assert.equal(esc.resets, 0, 'no reset into a hybrid app');
    assert.deepEqual(esc.flash.slice(0, 0x1000), bootBefore);
  });
  it('F4: a page that changes after its own verify (late damage) fails the final read-back', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.afterWrite = (addr) => {
      if (addr === AM32_APP_START + 3 * 256) esc.flash[0x5000] = 0x00; // after the last chunk of the first page
    };
    const err = await withSimulatedWrites(() =>
      flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn).then(
        () => assert.fail('install must fail'),
        (e: unknown) => e,
      ),
    );
    assert.ok(err instanceof Am32FinalVerifyError, String(err));
    assert.match(err.message, /0x8005000/);
    assert.equal(esc.resets, 0);
  });
  it('F4: a settings page that changes after its check fails the final read-back', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.afterWrite = (addr) => {
      if (addr === AM32_APP_START + 3 * 256) esc.flash[AM32_EEPROM_OFFSET + 10] = (esc.flash[AM32_EEPROM_OFFSET + 10] ?? 0) ^ 0x01;
    };
    const err = await withSimulatedWrites(() =>
      flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn).then(
        () => assert.fail('install must fail'),
        (e: unknown) => e,
      ),
    );
    assert.ok(err instanceof Am32FinalVerifyError, String(err));
    assert.match(err.message, /settings page/);
    assert.equal(esc.resets, 0);
  });
  it('F2: flushes before each command; a stale frame already buffered is dropped', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.queue(FakeEsc.frame(FOURWAY_CMD.DeviceInitFlash, 0, Uint8Array.of(0x34, 0x12, 0, FOURWAY_MODE_ARM_BLB)));
    const id = await identifyEsc(new FourWay(esc), 1);
    assert.deepEqual(id.mcu, {status: 'ok', value: 'AT32F421'});
    assert.ok(esc.flushes >= 2);
  });
  it('F2: a late reply for another address is rejected and the link refuses commands until testAlive', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const fw = new FourWay(esc);
    esc.lateFrames.push(FakeEsc.frame(FOURWAY_CMD.DeviceRead, 0x1000, new Uint8Array(17)));
    await assert.rejects(fw.read(AM32_EEPROM_OFFSET, 17), /does not match the request/);
    assert.equal(fw.isDesynced, true);
    await assert.rejects(fw.initFlash(0), /out of step/);
    await fw.testAlive();
    assert.equal(fw.isDesynced, false);
    assert.equal((await fw.read(AM32_EEPROM_OFFSET, 17)).length, 17);
  });
  it('F2: a timeout desyncs the link; identifyEsc resyncs before the next ESC', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const fw = new FourWay(esc);
    esc.dead = true;
    assert.equal((await identifyEsc(fw, 0)).mcu.status, 'unreadable');
    assert.equal(fw.isDesynced, true);
    esc.dead = false;
    const id = await identifyEsc(fw, 1);
    assert.equal(fw.isDesynced, false);
    assert.deepEqual(id.firmwareName, {status: 'ok', value: 'OPENESC_20_F421'});
  });
  it('F2: a device-info reply of the wrong length is rejected', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.lateFrames.push(FakeEsc.frame(FOURWAY_CMD.DeviceInitFlash, 0, Uint8Array.of(0x06, 0x47)));
    assert.equal((await identifyEsc(new FourWay(esc), 0)).mcu.status, 'unreadable');
  });
  it('with all flags on (simulated): first page erased first and written last, EEPROM = pinned defaults, bootloader untouched', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    esc.flash.fill(0xa5, AM32_EEPROM_OFFSET + 192, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE); // old settings tail
    const bootBefore = esc.flash.slice(0, 0x1000);
    const img = image();
    await withSimulatedWrites(() => flashAm32(new FourWay(esc), 0, img, ESC20, release, noop, allOn));
    assert.equal(esc.erases[0], AM32_APP_START);
    assert.equal(esc.writes[esc.writes.length - 4], AM32_APP_START, 'first app page written last (4 chunks)');
    assert.equal(esc.writes[esc.writes.length - 5], AM32_EEPROM_OFFSET, 'EEPROM defaults written just before it');
    assert.equal(esc.erases[esc.erases.length - 1], AM32_EEPROM_OFFSET, 'EEPROM page erased after the other app pages');
    assert.equal(esc.erases[1], 0x7800, 'the name-slot page is rewritten right after the first erase');
    assert.equal(esc.writes[0], 0x7800);
    assert.deepEqual(esc.flash.slice(AM32_NAME_SLOT_OFFSET, AM32_EEPROM_OFFSET), nameSlot('OPENESC_20_F421'));
    for (const a of [...esc.writes, ...esc.erases]) assert.ok(a >= AM32_APP_START && a <= AM32_EEPROM_OFFSET);
    assert.equal(esc.writes.filter((a) => a >= AM32_EEPROM_OFFSET).length, 1, 'one EEPROM write');
    assert.deepEqual(esc.flash.slice(0, 0x1000), bootBefore);
    const page = esc.flash.slice(AM32_EEPROM_OFFSET, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE);
    assert.deepEqual(page.slice(0, 192), makeEepromDefaults());
    assert.ok(page.slice(192).every((b) => b === 0xff), 'rest of the settings page erased');
    for (const p of img.pages) assert.deepEqual(esc.flash.slice(p.offset, p.offset + p.data.length), p.data);
  });

  it('refuses an image without EEPROM defaults, before touching flash', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const noDefaults = prepareAm32Image(makeHex(AT32F421_FLASH_BASE + AM32_APP_START, makeAm32App()), ESC20);
    await withSimulatedWrites(() =>
      assert.rejects(flashAm32(new FourWay(esc), 0, noDefaults, ESC20, release, noop, allOn), /no EEPROM defaults/),
    );
    assert.equal(esc.writes.length + esc.erases.length, 0);
  });
  it('a settings page that does not erase aborts before the defaults are written', async () => {
    const esc = new FakeEsc('OPENESC_20_F421');
    const orig = esc.write.bind(esc);
    esc.write = async (req: Uint8Array) => {
      if (req[1] === FOURWAY_CMD.DevicePageErase && req[5] === AM32_EEPROM_OFFSET / AM32_PAGE_SIZE) {
        esc.erases.push(AM32_EEPROM_OFFSET);
        esc.queue(FakeEsc.frame(req[1]!, 0, Uint8Array.of(0)));
        return;
      }
      return orig(req);
    };
    const settingsBefore = esc.flash.slice(AM32_EEPROM_OFFSET, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE);
    await withSimulatedWrites(() =>
      assert.rejects(flashAm32(new FourWay(esc), 0, image(), ESC20, release, noop, allOn), /did not erase the settings page/),
    );
    // Only the F5 fallback (all 0xFF, exactly the guarded 0x7C00 + 192), which cannot set bits: the defaults are never written.
    const eeWrites = esc.writes.map((a, i) => [a, esc.writeLens[i]]).filter(([a]) => a! >= AM32_EEPROM_OFFSET);
    assert.deepEqual(eeWrites, [[AM32_EEPROM_OFFSET, 192]]);
    assert.deepEqual(esc.flash.slice(AM32_EEPROM_OFFSET, AM32_EEPROM_OFFSET + AM32_PAGE_SIZE), settingsBefore);
    assert.equal(esc.resets, 0);
  });
  it('prepareAm32Image checks the EEPROM defaults: 192 bytes, layout v4', () => {
    const hex = makeHex(AT32F421_FLASH_BASE + AM32_APP_START, makeAm32App());
    assert.throws(() => prepareAm32Image(hex, ESC20, new Uint8Array(191)), /192 bytes/);
    const v3 = makeEepromDefaults();
    v3[1] = 3;
    assert.throws(() => prepareAm32Image(hex, ESC20, v3), /layout v4/);
  });
  it('prepareAm32Image accepts a raw .bin at the app address (same checks as hex)', () => {
    const img = prepareAm32Image(makeAm32App(), ESC20, makeEepromDefaults());
    assert.equal(img.pages.length, 27);
    assert.equal(img.start, AM32_APP_START);
    assert.throws(() => prepareAm32Image(makeAm32App('OPENESC_30_F421'), ESC20, makeEepromDefaults()), /not OPENESC_20_F421/);
    assert.throws(() => prepareAm32Image(new Uint8Array(0), ESC20), /no data/);
  });
});

describe('AM32 EEPROM write guard', () => {
  it('allows exactly 0x7C00..0x7CBF (192 bytes)', () => {
    assert.doesNotThrow(() => assertAm32EepromWritable(0x7c00, 192));
    assert.doesNotThrow(() => assertAm32EepromPageErasable(0x7c00));
  });
  it('refuses anything else: other lengths, offsets, the bootloader and the app', () => {
    for (const [o, l] of [[0x7c00, 191], [0x7c00, 193], [0x7c00, 1024], [0x7c01, 192], [0x7bc0, 192], [0x7be0, 64], [0x7cc0, 192], [0, 192], [0x0f00, 192], [0x1000, 192], [0x8000, 192], [0x7c00, 0], [-1, 192], [0x7c00, Number.NaN]] as const) {
      assert.throws(() => assertAm32EepromWritable(o, l), Am32AddressError, `${o}+${l}`);
    }
    for (const o of [0, 0x1000, 0x7800, 0x7c01, 0x8000]) assert.throws(() => assertAm32EepromPageErasable(o), Am32AddressError);
  });
  it('the app guard still refuses the EEPROM page', () => {
    assert.throws(() => assertAm32Writable(0x7c00, 192), /EEPROM/);
  });
});
