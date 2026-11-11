/**
 * C: the on-board identity scan (Picoboot.findInstalledTargets) against REAL
 * firmware bytes laid out as on-board flash. The release UF2s are not in the
 * repo (public, no binaries): the test reads the git-ignored bench copies in
 * .firmware-staging/ and skips when they are absent. The synthetic tests below
 * always run.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {fcDirectWriteGate} from './gates.ts';
import {Picoboot} from './picoboot.ts';
import {FLASHER_TARGETS} from './targets.ts';
import {parseUf2} from './uf2.ts';
import type {FirmwareRelease} from './manifest.ts';

const LITE = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_RP2350B')!;
const MINI = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_MINI_RP2350A')!;
const DIR = new URL('../../../.firmware-staging/', import.meta.url);
const LITE_UF2 = new URL('OpenFC-Lite_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_RP2350B.uf2', DIR);
const MINI_UF2 = new URL('OpenFC-Lite-Mini_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_MINI_RP2350A.uf2', DIR);
const haveReal = existsSync(LITE_UF2) && existsSync(MINI_UF2);

/** A Picoboot whose flash reads come from a byte map (0xFF where nothing is written). */
function boardWith(flash: Map<number, Uint8Array>): Picoboot {
  const pb = Object.create(Picoboot.prototype) as Picoboot & {read: (a: number, n: number) => Promise<Uint8Array>};
  pb.read = async (addr: number, len: number) => {
    const out = new Uint8Array(len).fill(0xff);
    for (const [base, data] of flash) {
      const from = Math.max(addr, base);
      const to = Math.min(addr + len, base + data.length);
      if (from < to) out.set(data.subarray(from - base, to - base), from - addr);
    }
    return out;
  };
  return pb;
}

function flashOf(uf2: Uint8Array): {flash: Map<number, Uint8Array>; start: number; end: number} {
  const img = parseUf2(uf2, {familyId: LITE.uf2Family, flashSize: LITE.flashSize});
  const flash = new Map<number, Uint8Array>();
  for (const p of img.pages) flash.set(p.addr, p.data);
  return {flash, start: img.start, end: img.end};
}

const release = (t: string): FirmwareRelease => ({
  target: t,
  kind: 'betaflight-uf2',
  version: 'v',
  firmware: 'f',
  channel: 'alpha',
  released: '',
  url: 'https://github.com/OpenDrone-hw/x/releases/download/v/x.uf2',
  size: 1,
  sha256: 'a'.repeat(64),
  published: true,
});
const gate = (chosen: typeof LITE, installed: string[] | null) =>
  fcDirectWriteGate({
    gates: {CHIP_PACKAGE_VERIFIED: true, PICOBOOT_WRITE_VERIFIED: true},
    chosen,
    release: release(chosen.target),
    verifiedFor: chosen.target,
    imageStart: 0x10000000,
    imageEnd: 0x10001000,
    chipPackage: {status: 'ok', value: chosen.chipPackage},
    flashBytes: null,
    installed,
  });

describe('C: on-board identity from real QC firmware bytes', {skip: haveReal ? false : 'bench UF2s not in .firmware-staging/'}, () => {
  it('a board running cf94838a (Lite) identifies as OPENFC_LITE_RP2350B only; the Mini image as MINI only', async () => {
    const lite = flashOf(readFileSync(LITE_UF2));
    const mini = flashOf(readFileSync(MINI_UF2));
    // Scan range = the NEW image's range, as the page does; try both images' ranges.
    for (const range of [lite, mini]) {
      assert.deepEqual(await boardWith(lite.flash).findInstalledTargets(range.start, range.end), [LITE.target]);
      assert.deepEqual(await boardWith(mini.flash).findInstalledTargets(range.start, range.end), [MINI.target]);
    }
  });
  it('the gate passes each board with its own firmware and refuses the other board both ways', async () => {
    const lite = flashOf(readFileSync(LITE_UF2));
    const mini = flashOf(readFileSync(MINI_UF2));
    const onLite = await boardWith(lite.flash).findInstalledTargets(lite.start, lite.end);
    const onMini = await boardWith(mini.flash).findInstalledTargets(lite.start, lite.end);
    assert.equal(gate(LITE, onLite).allowed, true);
    assert.equal(gate(MINI, onMini).allowed, true);
    assert.equal(gate(MINI, onLite).allowed, false, 'Lite firmware on board, Mini chosen');
    assert.equal(gate(LITE, onMini).allowed, false, 'Mini firmware on board, Lite chosen');
  });
});

describe('C: unknown, blank or third-party boards are still refused', () => {
  it('blank flash: no name found, refused with an actionable message', async () => {
    const found = await boardWith(new Map()).findInstalledTargets(0x10000000, 0x10010000);
    assert.deepEqual(found, []);
    const g = gate(LITE, found);
    assert.equal(g.allowed, false);
    assert.ok(g.reasons.some((r) => /Can't identify the firmware on this board.*copy method \(Other ways\)/.test(r)), g.reasons.join(' | '));
  });
  it('third-party firmware (some other target name): refused', async () => {
    const other = new TextEncoder().encode('Betaflight - SOME_OTHER_RP2350B\0');
    const found = await boardWith(new Map([[0x10005000, other]])).findInstalledTargets(0x10000000, 0x10010000);
    assert.deepEqual(found, []);
    assert.equal(gate(LITE, found).allowed, false);
  });
  it('a name split across two 4 KB sectors is still found (carry-over)', async () => {
    const name = new TextEncoder().encode(LITE.target);
    const at = 0x10001000 - 7;
    const found = await boardWith(new Map([[at, name]])).findInstalledTargets(0x10000000, 0x10003000);
    assert.deepEqual(found, [LITE.target]);
  });
  it('not scanned at all: refused', () => {
    assert.equal(gate(LITE, null).allowed, false);
  });
});
