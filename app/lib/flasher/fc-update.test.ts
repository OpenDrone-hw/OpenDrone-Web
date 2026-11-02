import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  BOOT_HINT,
  continueUpdate,
  DONE_TEXT,
  GATED_TEXT,
  startUpdate,
  STAGE_TEXT,
  type FlowDeps,
  type PicobootLike,
  type Prepared,
  type Stage,
} from './fc-update.ts';
import type {RebootConnection} from './fc-reboot.ts';
import type {BoardInfo} from './msp.ts';
import {FLASHER_TARGETS, type FlasherTarget} from './targets.ts';

const LITE = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_RP2350B')!;
const MINI = FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_MINI_RP2350A')!;
const ON = {CHIP_PACKAGE_VERIFIED: true, PICOBOOT_WRITE_VERIFIED: true};

const info = (boardName: string): BoardInfo => ({
  fcVariant: 'BTFL',
  fcVersion: '2026.12.0',
  apiVersion: '1.47',
  boardIdentifier: 'RP23',
  targetName: '',
  boardName,
  manufacturerId: 'OPFC',
});
const prepared = (t: FlasherTarget): Prepared => ({
  target: t,
  release: {
    target: t.target,
    kind: 'betaflight-uf2',
    version: 'v',
    firmware: 'f',
    channel: 'alpha',
    released: '',
    url: 'https://github.com/OpenDrone-hw/x/releases/download/v/x.uf2',
    size: 1,
    sha256: 'a'.repeat(64),
    published: true,
  },
  image: {familyId: t.uf2Family, pages: [], start: 0x10000000, end: 0x10001000, ignoredBlocks: 0} as never,
  bytes: new Uint8Array(1),
  sha256: 'a'.repeat(64),
  fileName: 'x.uf2',
});

type Opts = {
  gatesOn?: boolean;
  serial?: 'ok' | 'nopick' | 'noreply';
  board?: string;
  reboot?: 'ok' | 'fail';
  permitted?: boolean;
  picker?: 'ok' | 'fail';
  pkg?: 'QFN60' | 'QFN80' | null;
  installed?: string[];
  flash?: 'ok' | 'fail';
};

function rig(o: Opts = {}) {
  const log: string[] = [];
  const stages: Stage[] = [];
  const pb: PicobootLike = {
    chipInfo: async () => ({chipPackage: o.pkg === undefined ? 'QFN80' : o.pkg, deviceId: 1, flashBytes: null}),
    exclusive: async () => {},
    exitXip: async () => {},
    findInstalledTargets: async () => o.installed ?? [LITE.target],
    flashImage: async (_img, cb) => {
      log.push('flash');
      if (o.flash === 'fail') throw new Error('USB transfer failed');
      cb('write', 5, 10);
      cb('reboot', 10, 10);
    },
    close: async () => void log.push('pb.close'),
  };
  const conn: RebootConnection = {
    identify: async () => {
      if (o.serial === 'noreply') throw new Error('No reply from the flight controller. Is it running Betaflight?');
      return info(o.board ?? LITE.target);
    },
    rebootToBootloader: async () => {
      log.push('bl rom');
      if (o.reboot === 'fail') throw new Error('The flight controller did not open its CLI (no "#" prompt), so no restart was sent.');
    },
    close: async () => void log.push('serial.close'),
  };
  const deps: FlowDeps = {
    gates: ON,
    gatesOn: () => o.gatesOn ?? true,
    openSerial: async () => {
      log.push('requestPort');
      if (o.serial === 'nopick') throw new DOMException('No port selected by the user.', 'NotFoundError');
      return conn;
    },
    prepare: async (t) => {
      log.push(`prepare:${t.target}`);
      return prepared(t);
    },
    findBootsel: async () => (o.permitted ? {id: 'rp2350-boot'} : null),
    openPicoboot: async (dev) => {
      log.push(dev ? 'open-permitted' : 'requestDevice');
      if (o.picker === 'fail') throw new DOMException('No device selected.', 'NotFoundError');
      return pb;
    },
    onStage: (s) => void stages.push(s),
  };
  return {deps, log, stages};
}

describe('F: one-button FC update', () => {
  it('happy path with an already-permitted RP2350 Boot: serial, identify, verify, bl rom, open, check, install, restart', async () => {
    const r = rig({permitted: true});
    assert.deepEqual(await startUpdate(r.deps), {kind: 'done'});
    assert.deepEqual(r.log, ['requestPort', `prepare:${LITE.target}`, 'bl rom', 'serial.close', 'open-permitted', 'flash', 'pb.close']);
    assert.deepEqual([...new Set(r.stages)], ['serial', 'check', 'reboot', 'usb', 'install', 'restart']);
  });

  it('needing the WebUSB picker: stops at need-usb (no picker without a fresh click); Continue opens it and installs', async () => {
    const r = rig();
    const first = await startUpdate(r.deps);
    assert.equal(first.kind, 'need-usb');
    assert.ok(!r.log.includes('requestDevice'));
    if (first.kind !== 'need-usb') return;
    assert.deepEqual(await continueUpdate(r.deps, first), {kind: 'done'});
    assert.ok(r.log.includes('requestDevice') && r.log.includes('flash'));
  });

  it('identify decides the board: a Mini gets the Mini file and installs only with QFN60 + Mini firmware', async () => {
    const r = rig({board: MINI.target, pkg: 'QFN60', installed: [MINI.target], permitted: true});
    assert.deepEqual(await startUpdate(r.deps), {kind: 'done'});
    assert.ok(r.log.includes(`prepare:${MINI.target}`));
  });

  it('each stage failure names the stage and nothing is written', async () => {
    const cases: [Opts, Stage, RegExp][] = [
      [{serial: 'nopick'}, 'serial', /No device was selected/],
      [{serial: 'noreply'}, 'serial', /No reply/],
      [{reboot: 'fail'}, 'reboot', /did not open its CLI/],
    ];
    for (const [o, stage, text] of cases) {
      const r = rig(o);
      const res = await startUpdate(r.deps);
      assert.equal(res.kind, 'failed', stage);
      if (res.kind !== 'failed') continue;
      assert.equal(res.stage, stage);
      assert.match(res.text, text);
      assert.ok(!r.log.includes('flash'));
    }
    const pick = rig({picker: 'fail'});
    const p = await continueUpdate(pick.deps, {board: LITE, prepared: prepared(LITE)});
    assert.equal(p.kind === 'failed' && p.stage, 'usb');
    const fl = rig({flash: 'fail', permitted: true});
    const f = await startUpdate(fl.deps);
    assert.equal(f.kind === 'failed' && f.stage, 'install');
    assert.ok(fl.log.includes('pb.close'));
  });

  it('resume after BOOT: a failed bl rom keeps board and file; Continue installs from the WebUSB stage, no second download', async () => {
    const r = rig({reboot: 'fail'});
    const res = await startUpdate(r.deps);
    assert.equal(res.kind, 'failed');
    if (res.kind !== 'failed') return;
    assert.equal(res.board?.target, LITE.target);
    assert.ok(res.prepared);
    assert.deepEqual(await continueUpdate(r.deps, {board: res.board, prepared: res.prepared}), {kind: 'done'});
    assert.equal(r.log.filter((x) => x.startsWith('prepare')).length, 1);
  });

  it('resume when the board was never identified asks for the board first; nothing is opened', async () => {
    const r = rig();
    const res = await continueUpdate(r.deps, {board: null, prepared: null});
    assert.equal(res.kind, 'failed');
    if (res.kind === 'failed') assert.match(res.text, /Choose which board/);
    assert.ok(!r.log.includes('requestDevice'));
  });

  it('refusals end the flow with nothing written', async () => {
    const unknown = rig({board: 'SOME_OTHER_BOARD'});
    assert.equal((await startUpdate(unknown.deps)).kind, 'refused');
    assert.ok(!unknown.log.includes('bl rom'), 'an unknown board is not even restarted');
    const cases: [Opts, RegExp][] = [
      [{installed: [MINI.target]}, /this board is OpenFC-Lite Mini, not OpenFC-Lite/],
      [{pkg: 'QFN60', installed: [LITE.target]}, /chip doesn't match OpenFC-Lite/],
      [{installed: []}, /Can't identify the firmware on this board.*Other ways/],
      [{pkg: null}, /Not installing: .*Chip package unreadable/],
    ];
    for (const [o, re] of cases) {
      const r = rig({...o, permitted: true});
      const res = await startUpdate(r.deps);
      assert.equal(res.kind, 'refused', JSON.stringify(o));
      if (res.kind === 'refused') assert.match(res.text, re);
      assert.ok(!r.log.includes('flash'), 'never written past a refusal');
    }
    // Identified as Mini over serial, but the RP2350 Boot device is a Lite running Lite firmware: refused.
    const rev = rig({board: MINI.target, pkg: 'QFN80', installed: [LITE.target], permitted: true});
    assert.equal((await startUpdate(rev.deps)).kind, 'refused');
    assert.ok(!rev.log.includes('flash'));
  });

  it('gates off (production): the flow never starts', async () => {
    const r = rig({gatesOn: false});
    assert.deepEqual(await startUpdate(r.deps), {kind: 'refused', text: GATED_TEXT});
    assert.deepEqual(await continueUpdate(r.deps, {board: LITE, prepared: prepared(LITE)}), {kind: 'refused', text: GATED_TEXT});
    assert.deepEqual(r.log, []);
  });

  it('copy: the audience-checked stage lines', () => {
    assert.equal(STAGE_TEXT.usb, 'Now choose "RP2350 Boot" in the second window.');
    assert.equal(BOOT_HINT, 'Hold the BOOT button on the board while plugging in USB, then Continue.');
    assert.match(DONE_TEXT, /check your settings/);
  });
});
