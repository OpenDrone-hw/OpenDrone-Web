/**
 * OpenFC-Lite published same-origin (2026-11-03): the asset in public/, its
 * pin, the size + SHA-256 check before any parse/write, and the per-board
 * direct-install gate (Lite only; the Mini and the ESCs stay copy-only).
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {directInstallEnabled} from './direct-install.ts';
import {boardGatedText, startUpdate, type FlowDeps, type PicobootLike, type Prepared} from './fc-update.ts';
import type {RebootConnection} from './fc-reboot.ts';
import {FIRMWARE_MANIFEST, LITE_PIN, pinToRelease, targetPublished} from './firmware-manifest.ts';
import {fcDirectWriteGate, fcTargetProblems, knownFcNamesIn} from './gates.ts';
import {fetchVerifiedFirmware, isAllowedFirmwareUrl, isPublished, isSameOriginFirmwareUrl, type FirmwareRelease} from './manifest.ts';
import {Picoboot} from './picoboot.ts';
import {
  boardDirectInstallVerified,
  CHIP_PACKAGE_VERIFIED,
  effectiveFcGates,
  FLASHER_TARGETS,
  PICOBOOT_WRITE_VERIFIED,
  type FlasherTarget,
} from './targets.ts';
import {imageContainsAscii, parseUf2} from './uf2.ts';

const SHA = 'cf94838a4207f89c196ff3ba5c4e0136eb6e9920eb68033876b90c0b6f4b4196';
const SIZE = 899584;
const FILE = 'OpenFC-Lite_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_RP2350B.uf2';
const LITE = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_RP2350B')!;
const MINI = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_MINI_RP2350A')!;
const PAGE = 'https://opendrone.be/guides/flash';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const asset = new Uint8Array(read(`../../../public/firmware/openfc-lite/${FILE}`));
const lite = FIRMWARE_MANIFEST.find((r) => r.target === LITE.target)!;
const mini = FIRMWARE_MANIFEST.find((r) => r.target === MINI.target)!;
/** A Mini release as if it were pinned (any SHA): still no per-board evidence. */
const miniPinned: FirmwareRelease = pinToRelease('OPENFC_LITE_MINI_RP2350A', {...LITE_PIN, sha256: 'b'.repeat(64), url: '/firmware/openfc-lite-mini/x.uf2'});

function fetcher(bytes: Uint8Array, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(String(url));
    return new Response(bytes.slice());
  }) as unknown as typeof fetch;
}

describe('the asset and its pin', () => {
  it('public/firmware/openfc-lite/<file> is the bench-verified image byte for byte', () => {
    assert.equal(asset.length, SIZE);
    assert.equal(createHash('sha256').update(asset).digest('hex'), SHA);
  });

  it('the manifest pins it same-origin with size, SHA-256, version and config ref', () => {
    assert.equal(lite.url, `/firmware/openfc-lite/${FILE}`);
    assert.equal(lite.size, SIZE);
    assert.equal(lite.sha256, SHA);
    assert.equal(lite.version, 'Betaflight 2026.12.0-alpha (d593400)');
    assert.equal(lite.channel, 'alpha');
    assert.equal(lite.source?.configRef, 'a2b6666');
    assert.equal(lite.source?.buildTarget, 'OPENFC_LITE_RP2350B');
    assert.equal(lite.source?.firmwareUrl, 'https://github.com/OpenDrone-hw/betaflight/tree/d593400a05');
    assert.equal(lite.source?.configUrl, 'https://github.com/OpenDrone-hw/betaflight-config/tree/a2b666618f');
    assert.ok(isPublished(lite));
    assert.ok(targetPublished(LITE.target));
    for (const t of ['OPENFC_LITE_MINI_RP2350A', 'OPENESC_20_F421', 'OPENESC_30X30']) assert.equal(targetPublished(t), false, t);
  });

  it('the URL is same-origin, so connect-src \'self\' covers it (CSP unchanged)', () => {
    assert.ok(isSameOriginFirmwareUrl(lite.url));
    assert.equal(isAllowedFirmwareUrl(lite.url), false, 'not an external host');
    assert.equal(new URL(lite.url!, PAGE).origin, 'https://opendrone.be');
    const entry = read('../../entry.server.tsx').toString();
    const connect = /connectSrc:\s*\[([^\]]*)\]/.exec(entry)?.[1] ?? '';
    assert.deepEqual(
      connect.split(',').map((s) => s.trim()).filter(Boolean),
      [`"'self'"`, "'https://cdn.shopify.com'", "'https://challenges.cloudflare.com'", "'https://plausible.io'"],
    );
  });

  it('the same-origin rule refuses anything but a plain /firmware/<board>/<file> path', () => {
    for (const u of [
      '/firmware/openfc-lite/../x.uf2',
      '/firmware/openfc-lite/.x.uf2',
      '/firmware/x.uf2',
      '//evil.example/firmware/a/b.uf2',
      'https://evil.example/firmware/a/b.uf2',
      '/firmware/openfc-lite/a.uf2?x=1',
      '/firmware-staging/a.uf2',
    ]) {
      assert.equal(isSameOriginFirmwareUrl(u), false, u);
    }
  });

  it('the static assets get immutable caching for /firmware/*', () => {
    assert.match(read('../../../public/_headers').toString(), /\/firmware\/\*\r?\n\s+Cache-Control: public, max-age=31536000, immutable/);
  });
});

describe('size + SHA-256 before any parse or write', () => {
  it('fetches same-origin and accepts the exact bytes', async () => {
    const seen: string[] = [];
    const r = await fetchVerifiedFirmware(lite, PAGE, fetcher(asset, seen));
    assert.equal(r.sha256, SHA);
    assert.deepEqual(seen, [`https://opendrone.be/firmware/openfc-lite/${FILE}`]);
  });

  it('one flipped byte: refused with a checksum message', async () => {
    const bad = asset.slice();
    bad[1000] = bad[1000]! ^ 0xff;
    await assert.rejects(fetchVerifiedFirmware(lite, PAGE, fetcher(bad)), /checksum does not match the pinned SHA-256/);
  });

  it('wrong size: refused with a size message', async () => {
    await assert.rejects(fetchVerifiedFirmware(lite, PAGE, fetcher(asset.slice(0, SIZE - 512))), /size 899072 does not match the pinned size \(899584\)/);
  });
});

// A minimal flow rig: prepare runs the real fetch + verify + parse, like FcFlasher's prepareFor.
function rig(o: {board: string; bytes: Uint8Array; installed?: string[]; pkg?: 'QFN60' | 'QFN80'}) {
  const log: string[] = [];
  const pb: PicobootLike = {
    chipInfo: async () => ({chipPackage: o.pkg ?? 'QFN80', deviceId: 1, flashBytes: null}),
    exclusive: async () => {},
    exitXip: async () => {},
    findInstalledTargets: async () => o.installed ?? [LITE.target],
    flashImage: async (_img, cb) => {
      log.push('flash');
      cb('reboot', 1, 1);
    },
    close: async () => {},
  };
  const conn: RebootConnection = {
    identify: async () => ({fcVariant: 'BTFL', fcVersion: '', apiVersion: '', boardIdentifier: '', targetName: '', boardName: o.board, manufacturerId: 'OPFC'}),
    rebootToBootloader: async () => void log.push('bl rom'),
    close: async () => {},
  };
  const deps: FlowDeps = {
    // As FcFlasher wires it, with the browser able to reach USB and the staging switch off.
    gatesOn: (board) => directInstallEnabled(false) && (!board || directInstallEnabled(false, board.target)),
    openSerial: async () => conn,
    prepare: async (t: FlasherTarget): Promise<Prepared> => {
      log.push(`prepare:${t.target}`);
      const release = FIRMWARE_MANIFEST.find((r) => r.target === t.target && isPublished(r));
      if (!release) throw new Error('not published');
      const {bytes, sha256} = await fetchVerifiedFirmware(release, PAGE, fetcher(o.bytes));
      log.push('verified');
      const image = parseUf2(bytes, {familyId: t.uf2Family, flashSize: t.flashSize});
      return {target: t, release, image, bytes, sha256, fileName: FILE};
    },
    findBootsel: async () => ({id: 'boot'}),
    openPicoboot: async () => pb,
    onStage: () => {},
  };
  return {deps, log};
}

describe('per-board direct install', () => {
  it('Lite + the pinned SHA: direct install enabled; global flags untouched', () => {
    assert.equal(CHIP_PACKAGE_VERIFIED, false);
    assert.equal(PICOBOOT_WRITE_VERIFIED, false);
    assert.equal(directInstallEnabled(false, LITE.target), true);
    assert.equal(directInstallEnabled(false), true, 'the button shows: one board can use it');
    assert.equal(boardDirectInstallVerified(lite), true);
    assert.deepEqual(effectiveFcGates(lite), {CHIP_PACKAGE_VERIFIED: true, PICOBOOT_WRITE_VERIFIED: true});
    assert.deepEqual(effectiveFcGates(), {CHIP_PACKAGE_VERIFIED: false, PICOBOOT_WRITE_VERIFIED: false});
  });

  it('Lite with any other SHA is unverified again', () => {
    assert.equal(boardDirectInstallVerified({...lite, sha256: 'c'.repeat(64)}), false);
  });

  it('Mini and the ESCs: copy-only, direct install disabled', () => {
    assert.equal(mini.published, false);
    for (const t of ['OPENFC_LITE_MINI_RP2350A', 'OPENESC_20_F421', 'OPENESC_30X30']) assert.equal(directInstallEnabled(false, t), false, t);
    assert.equal(boardDirectInstallVerified(miniPinned), false);
    assert.equal(boardDirectInstallVerified({target: MINI.target, sha256: SHA}), false, 'the Lite SHA does not verify the Mini');
    assert.deepEqual(effectiveFcGates(miniPinned), {CHIP_PACKAGE_VERIFIED: false, PICOBOOT_WRITE_VERIFIED: false});
    const gate = fcDirectWriteGate({
      chosen: MINI,
      release: miniPinned,
      verifiedFor: MINI.target,
      imageStart: 0x10000000,
      imageEnd: 0x10001000,
      chipPackage: {status: 'ok', value: 'QFN60'},
      flashBytes: null,
      installed: [MINI.target],
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reasons.filter((r) => /not verified on hardware/.test(r)).length, 2);
  });

  it('the write gate allows the Lite with its pinned image and default (false) flags', () => {
    const gate = fcDirectWriteGate({
      chosen: LITE,
      release: lite,
      verifiedFor: LITE.target,
      imageStart: 0x10000000,
      imageEnd: 0x10000000 + SIZE / 2,
      chipPackage: {status: 'ok', value: 'QFN80'},
      flashBytes: null,
      installed: [LITE.target],
    });
    assert.deepEqual(gate, {allowed: true, reasons: []});
  });

  it('flashImage: with the Lite release the flag check passes (fails on the image); without it, disabled', async () => {
    const pb = Object.create(Picoboot.prototype) as Picoboot;
    await assert.rejects(pb.flashImage({start: 0} as never, () => {}, lite), /does not start at the beginning of flash/);
    await assert.rejects(pb.flashImage({start: 0} as never, () => {}), /disabled until it is verified/);
    await assert.rejects(pb.flashImage({start: 0} as never, () => {}, miniPinned), /disabled until it is verified/);
  });

  it('flow: Lite board + correct file installs', async () => {
    const r = rig({board: LITE.target, bytes: asset});
    assert.deepEqual(await startUpdate(r.deps), {kind: 'done'});
    assert.deepEqual(r.log, [`prepare:${LITE.target}`, 'verified', 'bl rom', 'flash']);
  });

  it('flow: SHA mismatch refuses before parse, restart or write', async () => {
    const bad = asset.slice();
    bad[SIZE - 1] = bad[SIZE - 1]! ^ 1;
    const r = rig({board: LITE.target, bytes: bad});
    const res = await startUpdate(r.deps);
    assert.equal(res.kind, 'failed');
    assert.match((res as {text: string}).text, /checksum does not match/);
    assert.deepEqual(r.log, [`prepare:${LITE.target}`]);
  });

  it('flow: size mismatch refuses before parse, restart or write', async () => {
    const r = rig({board: LITE.target, bytes: asset.slice(0, SIZE - 1)});
    const res = await startUpdate(r.deps);
    assert.equal(res.kind, 'failed');
    assert.match((res as {text: string}).text, /does not match the pinned size/);
    assert.deepEqual(r.log, [`prepare:${LITE.target}`]);
  });

  it('flow: a Mini board is refused before anything is downloaded or restarted', async () => {
    const r = rig({board: MINI.target, bytes: asset});
    assert.deepEqual(await startUpdate(r.deps), {kind: 'refused', text: boardGatedText(MINI)});
    assert.equal(boardGatedText(MINI), "Direct install isn't available for the OpenFC-Lite Mini yet. Use Other ways.");
    assert.deepEqual(r.log, []);
  });

  it('flow: a Lite-reporting board that actually runs Mini firmware is refused at the write gate', async () => {
    const r = rig({board: LITE.target, bytes: asset, installed: [MINI.target]});
    const res = await startUpdate(r.deps);
    assert.equal(res.kind, 'refused');
    assert.match((res as {text: string}).text, /this board is OpenFC-Lite Mini, not OpenFC-Lite/);
    assert.ok(!r.log.includes('flash'));
  });

  it('Mini board + the Lite image: refused (identity, image name, write gate)', () => {
    const image = parseUf2(asset, {familyId: LITE.uf2Family, flashSize: LITE.flashSize});
    const names = knownFcNamesIn((n) => imageContainsAscii(image, n));
    assert.deepEqual(names, [LITE.target], 'the real file names only the Lite target');
    const problems = fcTargetProblems({chosen: MINI, manifestTarget: lite.target, imageNames: names});
    assert.ok(problems.some((p) => /entry is for OPENFC_LITE_RP2350B/.test(p)));
    assert.ok(problems.some((p) => /does not contain the target name OPENFC_LITE_MINI_RP2350A/.test(p)));
    const gate = fcDirectWriteGate({
      chosen: MINI,
      release: lite,
      verifiedFor: LITE.target,
      imageStart: image.start,
      imageEnd: image.end,
      chipPackage: {status: 'ok', value: 'QFN60'},
      flashBytes: null,
      installed: [MINI.target],
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reasons.filter((r) => /not verified on hardware/.test(r)).length, 2, 'Lite evidence never counts for a Mini');
    assert.ok(gate.reasons.some((r) => /entry is for OPENFC_LITE_RP2350B/.test(r)));
  });

  it('Lite board + a Mini report or Mini chip: refused', () => {
    assert.ok(fcTargetProblems({chosen: LITE, reported: {boardName: MINI.target, targetName: '', manufacturerId: 'OPFC'}}).length > 0);
    const gate = fcDirectWriteGate({
      chosen: LITE,
      release: lite,
      verifiedFor: LITE.target,
      imageStart: 0x10000000,
      imageEnd: 0x10001000,
      chipPackage: {status: 'ok', value: 'QFN60'},
      flashBytes: null,
      installed: [LITE.target],
    });
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.some((r) => /Chip package QFN60 does not match/.test(r)));
  });
});
