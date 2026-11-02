/**
 * Staging bench switch tests (synthetic data only).
 *
 * staging.ts reads `import.meta.env.VITE_FLASH_STAGING_GATES`, which plain Node
 * does not have. So this file registers a loader that rewrites exactly that
 * expression in staging.ts to `globalThis.__TEST_VITE_ENV__` (staging.ts only),
 * then imports everything dynamically. The rest of the code is unmodified. Each
 * test file runs in its own process, so nothing leaks into flasher.test.ts,
 * which runs with the real (absent) env and proves the switch is off by default.
 */
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {afterEach, describe, it} from 'node:test';
import type {FirmwareRelease} from './manifest.ts';

const HOOK = `
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (url.endsWith('/flasher/staging.ts')) {
    const before = String(r.source);
    const src = before.replaceAll('import.meta.env', 'globalThis.__TEST_VITE_ENV__');
    if (src === before) throw new Error('staging.ts no longer reads import.meta.env');
    return {...r, source: src};
  }
  return r;
}`;
register('data:text/javascript,' + encodeURIComponent(HOOK));

const g = globalThis as unknown as {window?: unknown; __TEST_VITE_ENV__?: unknown};

const {stagingBenchEnabled, isStagingHost} = await import('./staging.ts');
const L = await import('./am32-layout.ts');
const {Picoboot, PicobootError} = await import('./picoboot.ts');
const {FourWay, FOURWAY_CMD, crc16Xmodem} = await import('./fourway.ts');
const {flashAm32, prepareAm32Image, identifyEsc} = await import('./am32.ts');
const gates = await import('./gates.ts');
const man = await import('./manifest.ts');
const fm = await import('./firmware-manifest.ts');
const T = await import('./targets.ts');

const ESC20 = T.ESC_TARGETS[0]!;
const MINI = T.FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_MINI_RP2350A')!;
const ON = {VITE_FLASH_STAGING_GATES: '1'};

function setup(host: string | null, env: unknown): void {
  if (host === null) delete g.window;
  else g.window = {location: {hostname: host}};
  if (env === undefined) delete g.__TEST_VITE_ENV__;
  else g.__TEST_VITE_ENV__ = env;
}
afterEach(() => setup(null, undefined));

describe('stagingBenchEnabled: env + window + host', () => {
  it('is false with no env, on every host, with or without a window', () => {
    for (const h of ['localhost', '127.0.0.1', 'x.trycloudflare.com', 'opendrone.be', null]) {
      setup(h, undefined);
      assert.equal(stagingBenchEnabled(), false, String(h));
    }
  });
  it('is false for any env value other than exactly "1"', () => {
    for (const v of ['0', '', 'true', 'yes', ' 1', 1, true]) {
      setup('localhost', {VITE_FLASH_STAGING_GATES: v});
      assert.equal(stagingBenchEnabled(), false, String(v));
    }
    setup('localhost', {});
    assert.equal(stagingBenchEnabled(), false);
  });
  it('is false without a window even with the env set', () => {
    setup(null, ON);
    assert.equal(stagingBenchEnabled(), false);
  });
  it('is false for production, workers.dev, pages.dev and lookalike hosts even with the env set', () => {
    for (const h of [
      'opendrone.be',
      'www.opendrone.be',
      'opendrone.workers.dev',
      'foo.opendrone.workers.dev',
      'opendrone.pages.dev',
      'abc.opendrone.pages.dev',
      'trycloudflare.com',
      'trycloudflare.com.evil.com',
      'evil-trycloudflare.com',
      'x.trycloudflare.com.opendrone.be',
      'localhost.evil.com',
      'evil.localhost',
      '127.0.0.1.evil.com',
      '127.0.0.2',
      '::1',
      '',
      'LOCALHOST',
    ]) {
      setup(h, ON);
      assert.equal(stagingBenchEnabled(), false, h);
    }
  });
  it('is true only for localhost, 127.0.0.1 and *.trycloudflare.com with the env set', () => {
    for (const h of ['localhost', '127.0.0.1', 'random-words-here.trycloudflare.com', 'a.b.trycloudflare.com']) {
      setup(h, ON);
      assert.equal(stagingBenchEnabled(), true, h);
    }
  });
  it('isStagingHost rejects non-strings', () => {
    assert.equal(isStagingHost(undefined), false);
    assert.equal(isStagingHost(null), false);
  });
});

// ---------------------------------------------------------------------------
// Simulated ESC (synthetic)
// ---------------------------------------------------------------------------
const slot = (name: string) => {
  const s = new Uint8Array(L.AM32_NAME_SLOT_SIZE);
  s.set(new TextEncoder().encode(name), 0);
  return s;
};

class FakeEsc {
  flash = new Uint8Array(0x8000).fill(0xff);
  writes: number[] = [];
  erases: number[] = [];
  out = new Uint8Array(0);
  signature = L.AM32_SIGNATURE_AT32F421;
  constructor(name: string) {
    this.flash.fill(0x11, 0, 0x1000);
    this.flash.fill(0x5a, L.AM32_APP_START, L.AM32_NAME_SLOT_OFFSET);
    this.flash.set(slot(name), L.AM32_NAME_SLOT_OFFSET);
    this.flash.fill(0xa5, L.AM32_EEPROM_OFFSET, L.AM32_EEPROM_OFFSET + 0x400); // old settings
  }
  flush(): void {
    this.out = new Uint8Array(0);
  }
  static frame(cmd: number, addr: number, reply: Uint8Array): Uint8Array {
    const body = Uint8Array.from([0x2e, cmd, addr >> 8, addr & 0xff, reply.length & 0xff, ...reply, 0]);
    const crc = crc16Xmodem(body);
    return Uint8Array.from([...body, crc >> 8, crc & 0xff]);
  }
  async write(req: Uint8Array): Promise<void> {
    const cmd = req[1]!;
    const addr = (req[2]! << 8) | req[3]!;
    const params = req.subarray(5, 5 + (req[4] || 256));
    let reply: Uint8Array = Uint8Array.of(0);
    if (cmd === FOURWAY_CMD.DeviceInitFlash) {
      reply = Uint8Array.of(this.signature & 0xff, this.signature >> 8, 0, L.FOURWAY_MODE_ARM_BLB);
    } else if (cmd === FOURWAY_CMD.DeviceRead) {
      reply = this.flash.slice(addr, addr + (params[0] || 256));
    } else if (cmd === FOURWAY_CMD.DevicePageErase) {
      this.erases.push(params[0]! * L.AM32_PAGE_SIZE);
      this.flash.fill(0xff, params[0]! * L.AM32_PAGE_SIZE, (params[0]! + 1) * L.AM32_PAGE_SIZE);
    } else if (cmd === FOURWAY_CMD.DeviceWrite) {
      this.writes.push(addr);
      this.flash.set(params, addr);
    }
    this.out = Uint8Array.from([...this.out, ...FakeEsc.frame(cmd, addr, reply)]);
  }
  async readFrame<T>(decode: (buf: Uint8Array) => {value: T; consumed: number} | null): Promise<T> {
    const hit = decode(this.out);
    if (!hit) throw new Error('no reply');
    this.out = this.out.slice(hit.consumed);
    return hit.value;
  }
}

const app = (name = 'OPENESC_20_F421') => {
  const b = new Uint8Array(L.AM32_EEPROM_OFFSET - L.AM32_APP_START);
  for (let i = 0; i < b.length; i++) b[i] = ((i * 7 + 1) & 0x7f) | 0x80;
  b.set(slot(name), L.AM32_NAME_SLOT_OFFSET - L.AM32_APP_START);
  return b;
};
const defaults = () => {
  const b = new Uint8Array(192);
  for (let i = 0; i < b.length; i++) b[i] = (i * 13 + 5) & 0xff;
  b[1] = 4;
  return b;
};
const release = (over: Partial<FirmwareRelease> = {}): FirmwareRelease => ({
  target: ESC20.target,
  kind: 'am32-bin',
  version: 't',
  firmware: 't',
  channel: 'alpha',
  released: '',
  url: '/firmware-staging/t.bin',
  size: 4,
  sha256: 'a'.repeat(64),
  published: true,
  ...over,
});
const noop = () => {};
const fourWay = (esc: FakeEsc) => new FourWay(esc as never);
const run = (esc: FakeEsc, img: ReturnType<typeof prepareAm32Image>, rel = release()) =>
  flashAm32(fourWay(esc), 0, img, ESC20, rel, noop);
const writeCount = (esc: FakeEsc) => esc.writes.length + esc.erases.length;

describe('switch OFF: every write primitive still refuses', () => {
  it('am32 primitives, flashAm32 and the picoboot flash check refuse; effective gates are false', async () => {
    for (const [h, env] of [
      ['localhost', undefined],
      ['opendrone.be', ON],
      ['www.opendrone.be', ON],
      ['x.workers.dev', ON],
      ['x.pages.dev', ON],
    ] as const) {
      setup(h, env);
      assert.equal(L.am32WritesEnabled(), false, h);
      assert.ok(Object.values(L.effectiveAm32Gates()).every((v) => v === false));
      assert.deepEqual(T.effectiveFcGates(), {CHIP_PACKAGE_VERIFIED: false, PICOBOOT_WRITE_VERIFIED: false});
      const esc = new FakeEsc('OPENESC_20_F421');
      const fw = fourWay(esc);
      await assert.rejects(fw.pageEraseUnchecked(4), L.Am32WriteDisabledError);
      await assert.rejects(fw.writeUnchecked(0x1000, new Uint8Array(4)), L.Am32WriteDisabledError);
      await assert.rejects(run(esc, prepareAm32Image(app(), ESC20, defaults())), L.Am32WriteDisabledError);
      assert.equal(writeCount(esc), 0);
      const pb = Object.create(Picoboot.prototype) as {flashImage: (i: never, p: () => void) => Promise<void>};
      await assert.rejects(pb.flashImage({} as never, noop), (e: Error) => e instanceof PicobootError && /disabled/.test(e.message));
    }
  });
  it('the shipped constants are all still false', () => {
    assert.equal(T.CHIP_PACKAGE_VERIFIED, false);
    assert.equal(T.PICOBOOT_WRITE_VERIFIED, false);
    assert.ok(Object.values(L.AM32_GATES).every((v) => v === false));
  });
  it('the ESC UI gate lists all four flags as unverified on a production host', () => {
    setup('opendrone.be', ON);
    const gate = gates.escDirectWriteGate({
      chosen: ESC20,
      release: release({url: 'https://github.com/OpenDrone-hw/x/releases/download/v1/a.hex', kind: 'am32-hex'}),
      verifiedFor: ESC20.target,
      mcu: {status: 'ok', value: 'AT32F421'},
      firmwareName: {status: 'ok', value: 'OPENESC_20_F421'},
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reasons.filter((r) => /not verified on hardware/.test(r)).length, 4);
  });
});

describe('switch ON: flags pass, matching still refuses', () => {
  it('effective flags are true, constants unchanged', () => {
    setup('localhost', ON);
    assert.equal(L.am32WritesEnabled(), true);
    assert.deepEqual(T.effectiveFcGates(), {CHIP_PACKAGE_VERIFIED: true, PICOBOOT_WRITE_VERIFIED: true});
    assert.equal(T.CHIP_PACKAGE_VERIFIED, false);
    assert.ok(Object.values(L.AM32_GATES).every((v) => v === false));
  });
  it('picoboot flashImage passes the flag check (fails later, on the image)', async () => {
    setup('127.0.0.1', ON);
    const pb = Object.create(Picoboot.prototype) as {flashImage: (i: never, p: () => void) => Promise<void>};
    await assert.rejects(pb.flashImage({start: 0} as never, noop), /does not start at the beginning of flash/);
  });
  it('ESC gate: only the flag reasons disappear; MCU, name, target and release checks still block', () => {
    setup('localhost', ON);
    const base = {
      chosen: ESC20,
      release: release(),
      verifiedFor: ESC20.target,
      mcu: {status: 'ok', value: 'AT32F421'} as const,
      firmwareName: {status: 'ok', value: 'OPENESC_20_F421'} as const,
    };
    assert.deepEqual(gates.escDirectWriteGate(base).reasons, []);
    assert.equal(gates.escDirectWriteGate({...base, firmwareName: {status: 'ok', value: 'OPENESC_30_F421'}}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, mcu: {status: 'unknown', detail: 'x'}}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, verifiedFor: 'OTHER'}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, release: release({target: 'OTHER'})}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, release: release({published: false})}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, mcu: null}).allowed, false);
  });
  it('FC gate: flags pass, chip package, target, release and installed-firmware checks still block', () => {
    setup('localhost', ON);
    const rel = fm.pinToRelease('OPENFC_LITE_MINI_RP2350A', fm.STAGING_PINNED.OPENFC_LITE_MINI_RP2350A!);
    const ok = {
      chosen: MINI,
      release: rel,
      verifiedFor: MINI.target,
      imageStart: 0x10000000,
      imageEnd: 0x10001000,
      chipPackage: {status: 'ok', value: 'QFN60'} as const,
      flashBytes: null,
      installed: [MINI.target],
    };
    assert.deepEqual(gates.fcDirectWriteGate(ok).reasons, []);
    assert.equal(gates.fcDirectWriteGate({...ok, chipPackage: {status: 'ok', value: 'QFN80'}}).allowed, false);
    assert.equal(gates.fcDirectWriteGate({...ok, chipPackage: null}).allowed, false);
    assert.equal(gates.fcDirectWriteGate({...ok, verifiedFor: 'OPENFC_LITE_RP2350B'}).allowed, false);
    assert.equal(gates.fcDirectWriteGate({...ok, installed: ['OPENFC_LITE_RP2350B']}).allowed, false);
    assert.equal(gates.fcDirectWriteGate({...ok, installed: null}).allowed, false);
    assert.equal(gates.fcDirectWriteGate({...ok, release: {...rel, published: false}}).allowed, false);
  });
  it('flashAm32 still refuses a blank, wrong-name or wrong-chip ESC, a wrong image target and a bad release', async () => {
    setup('localhost', ON);
    const img = prepareAm32Image(app(), ESC20, defaults());
    for (const esc of [new FakeEsc('OPENESC_30_F421'), new FakeEsc('')]) {
      await assert.rejects(run(esc, img), /Not writing/);
      assert.equal(writeCount(esc), 0);
    }
    const wrongChip = new FakeEsc('OPENESC_20_F421');
    wrongChip.signature = 0x1234;
    await assert.rejects(run(wrongChip, img), /Not writing/);
    assert.equal(writeCount(wrongChip), 0);
    const other = new FakeEsc('OPENESC_20_F421');
    await assert.rejects(run(other, {...img, target: 'OTHER'}), /another ESC/);
    await assert.rejects(run(other, img, release({sha256: 'zz'})), /Not writing/);
    await assert.rejects(run(other, prepareAm32Image(app(), ESC20)), /no EEPROM defaults/);
    assert.equal(writeCount(other), 0);
  });
  it('simulated ESC ends up with the app and the pinned EEPROM defaults; bootloader untouched', async () => {
    setup('localhost', ON);
    const esc = new FakeEsc('OPENESC_20_F421');
    const boot = esc.flash.slice(0, 0x1000);
    const img = prepareAm32Image(app(), ESC20, defaults());
    await run(esc, img);
    for (const p of img.pages) assert.deepEqual(esc.flash.slice(p.offset, p.offset + p.data.length), p.data);
    const page = esc.flash.slice(L.AM32_EEPROM_OFFSET, L.AM32_EEPROM_OFFSET + 0x400);
    assert.deepEqual(page.slice(0, 192), defaults());
    assert.ok(page.slice(192).every((b) => b === 0xff));
    assert.deepEqual(esc.flash.slice(0, 0x1000), boot);
    for (const a of [...esc.writes, ...esc.erases]) assert.ok(a >= L.AM32_APP_START && a <= L.AM32_EEPROM_OFFSET);
    assert.equal(esc.erases.at(-1), L.AM32_EEPROM_OFFSET);
    assert.equal(esc.writes.at(-5), L.AM32_EEPROM_OFFSET);
    assert.equal(esc.writes.at(-4), L.AM32_APP_START, 'first app page last');
    assert.deepEqual((await identifyEsc(fourWay(esc), 0)).firmwareName, {status: 'ok', value: 'OPENESC_20_F421'});
  });
});

describe('staging manifest exists only with the switch on', () => {
  const MINI_FILE = 'OpenFC-Lite-Mini_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_MINI_RP2350A.uf2';
  it('off: production manifest only, all unpublished, no staging URL accepted', () => {
    for (const [h, env] of [
      ['localhost', undefined],
      ['opendrone.be', ON],
    ] as const) {
      setup(h, env);
      for (const t of ['OPENFC_LITE_MINI_RP2350A', 'OPENESC_20_F421', 'OPENFC_LITE_RP2350B', 'OPENESC_30X30']) {
        assert.ok(fm.releasesFor(t).every((r) => !man.isPublished(r) && r.url === null), `${h} ${t}`);
      }
      assert.equal(man.isStagingFirmwareUrl('/firmware-staging/' + MINI_FILE), false);
      const leaked = fm.pinToRelease('OPENFC_LITE_MINI_RP2350A', fm.STAGING_PINNED.OPENFC_LITE_MINI_RP2350A!);
      assert.equal(man.isPublished(leaked), false);
    }
    assert.deepEqual(fm.PINNED, {
      OPENFC_LITE_RP2350B: null,
      OPENFC_LITE_MINI_RP2350A: null,
      OPENESC_20_F421: null,
      OPENESC_30X30: null,
    });
  });
  it('on: Mini and ESC 20x20 resolve to same-origin /firmware-staging/ with the pinned hashes', () => {
    setup('x.trycloudflare.com', ON);
    const [mini] = fm.releasesFor('OPENFC_LITE_MINI_RP2350A');
    assert.equal(man.isPublished(mini!), true);
    assert.equal(mini!.url, '/firmware-staging/' + MINI_FILE);
    assert.equal(mini!.sha256, '75dca15360c94c168b6fb81c58ae4ebb0432be64155e6e2afdbf4197288ea457');
    assert.equal(mini!.size, 897536);
    assert.equal(mini!.version, '2026.12.0-alpha (d593400 + cfg a2b6666)');
    assert.equal(mini!.channel, 'alpha');
    const [escR] = fm.releasesFor('OPENESC_20_F421');
    assert.equal(man.isPublished(escR!), true);
    assert.equal(escR!.kind, 'am32-bin');
    assert.equal(escR!.url, '/firmware-staging/OpenESC-20x20_AM32_OPENESC_20_F421_2.21.bin');
    assert.equal(escR!.sha256, '24ed68c8d0e6eb3b9f0f0cd3713cb08397a805cf9a2450d9254d818c457c3b66');
    assert.equal(escR!.size, 27648);
    assert.equal(escR!.version, '2.21');
    assert.deepEqual(escR!.eepromDefaults, {
      url: '/firmware-staging/OpenESC-20x20_AM32_EEPROM_DEFAULT_v4.bin',
      sha256: '8e5cd69bc32e07154e9866ca737ee53a9d5b134059934fbfd9c3df664e2b1fa6',
      size: 192,
    });
    assert.equal(T.escTargetByName('OPENESC_30_F421'), undefined);
    assert.doesNotThrow(() => man.resolveRelease(escR!));
  });
  it('on: OpenFC-Lite gets its own QC image (same d593400 + cfg a2b6666 build, its own target)', () => {
    setup('x.trycloudflare.com', ON);
    const [lite] = fm.releasesFor('OPENFC_LITE_RP2350B');
    assert.equal(man.isPublished(lite!), true);
    assert.equal(lite!.target, 'OPENFC_LITE_RP2350B');
    assert.equal(lite!.kind, 'betaflight-uf2');
    assert.equal(lite!.url, '/firmware-staging/OpenFC-Lite_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_RP2350B.uf2');
    assert.equal(lite!.sha256, 'cf94838a4207f89c196ff3ba5c4e0136eb6e9920eb68033876b90c0b6f4b4196');
    assert.equal(lite!.size, 899584);
    assert.equal(lite!.version, '2026.12.0-alpha (d593400 + cfg a2b6666)');
    assert.equal(lite!.channel, 'alpha');
    assert.doesNotMatch(lite!.url!, /MINI/);
    assert.doesNotThrow(() => man.resolveRelease(lite!));
  });
  it('on: OpenESC 30x30 pins exactly the 20x20 files (QC record) under its own key', () => {
    setup('x.trycloudflare.com', ON);
    const [e20] = fm.releasesFor('OPENESC_20_F421');
    const [e30] = fm.releasesFor('OPENESC_30X30');
    assert.equal(man.isPublished(e30!), true);
    assert.equal(e30!.target, 'OPENESC_30X30');
    for (const k of ['kind', 'url', 'sha256', 'size', 'version', 'channel', 'eepromDefaults'] as const) {
      assert.deepEqual(e30![k], e20![k], k);
    }
    assert.doesNotThrow(() => man.resolveRelease(e30!));
  });
  it('the staging route serves exactly the four bench files', () => {
    assert.deepEqual([...fm.STAGING_FILE_NAMES].sort(), [
      'OpenESC-20x20_AM32_EEPROM_DEFAULT_v4.bin',
      'OpenESC-20x20_AM32_OPENESC_20_F421_2.21.bin',
      'OpenFC-Lite-Mini_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_MINI_RP2350A.uf2',
      'OpenFC-Lite_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_RP2350B.uf2',
    ]);
  });
  it('on: only plain file names under /firmware-staging/ are accepted', () => {
    setup('localhost', ON);
    for (const u of [
      '/firmware-staging/../x.bin',
      '/firmware-staging/',
      '/firmware-staging/a/b.bin',
      '//evil.com/firmware-staging/a.bin',
      'https://evil.com/firmware-staging/a.bin',
      '/other/a.bin',
      '/firmware-staging/.hidden',
      '/firmware-staging/a.bin?x=1',
    ]) {
      assert.equal(man.isStagingFirmwareUrl(u), false, u);
    }
    assert.equal(man.isStagingFirmwareUrl('/firmware-staging/a.bin'), true);
  });
  it('on: fetch verifies app and EEPROM defaults against the pinned hash and size, same origin only', async () => {
    setup('localhost', ON);
    const body = Uint8Array.from({length: 8}, (_, i) => i + 1);
    const eep = defaults();
    const sha = man.sha256Hex;
    const rel = release({
      url: '/firmware-staging/a.bin',
      size: 8,
      sha256: await sha(body),
      eepromDefaults: {url: '/firmware-staging/e.bin', size: 192, sha256: await sha(eep)},
    });
    const seen: string[] = [];
    const fetcher = (async (u: string) => {
      seen.push(u);
      const b = u.endsWith('a.bin') ? body : eep;
      return {ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)};
    }) as unknown as typeof fetch;
    const out = await man.fetchVerifiedFirmware(rel, 'http://localhost:5173/flash', fetcher);
    assert.deepEqual(seen, ['http://localhost:5173/firmware-staging/a.bin', 'http://localhost:5173/firmware-staging/e.bin']);
    assert.deepEqual(out.eeprom, eep);
    const bad = {...rel, eepromDefaults: {url: '/firmware-staging/e.bin', size: 192, sha256: 'b'.repeat(64)}};
    await assert.rejects(man.fetchVerifiedFirmware(bad, 'http://localhost:5173/flash', fetcher), /EEPROM defaults checksum/);
    // Switch off: the same entry is a placeholder and is never fetched.
    setup('opendrone.be', ON);
    seen.length = 0;
    await assert.rejects(man.fetchVerifiedFirmware(rel, 'https://opendrone.be/flash', fetcher), man.FirmwareNotPublishedError);
    assert.deepEqual(seen, []);
  });
});

describe('Lite vs Mini: a mix-up is refused in both directions (switch ON)', () => {
  const LITE = T.FLASHER_TARGETS.find((t) => t.target === 'OPENFC_LITE_RP2350B')!;
  const pkg = {OPENFC_LITE_MINI_RP2350A: 'QFN60', OPENFC_LITE_RP2350B: 'QFN80'} as const;
  const pairs = [
    [MINI, LITE],
    [LITE, MINI],
  ] as const;
  const okFor = (b: typeof MINI) => ({
    chosen: b,
    release: fm.releasesFor(b.target)[0]!,
    verifiedFor: b.target,
    imageStart: 0x10000000,
    imageEnd: 0x10001000,
    chipPackage: {status: 'ok', value: pkg[b.target as keyof typeof pkg]} as const,
    flashBytes: null,
    installed: [b.target],
  });
  it('each board passes with its own image, package and installed firmware', () => {
    setup('x.trycloudflare.com', ON);
    for (const b of [MINI, LITE]) assert.deepEqual(gates.fcDirectWriteGate(okFor(b)).reasons, [], b.target);
  });
  it('direct write: the other board release, verified file, chip package or installed firmware each block', () => {
    setup('x.trycloudflare.com', ON);
    for (const [chosen, other] of pairs) {
      const ok = okFor(chosen);
      const otherRel = fm.releasesFor(other.target)[0]!;
      assert.equal(man.isPublished(otherRel), true);
      const cases = {
        release: {...ok, release: otherRel},
        verifiedFor: {...ok, verifiedFor: other.target},
        chipPackage: {...ok, chipPackage: {status: 'ok', value: pkg[other.target as keyof typeof pkg]} as const},
        installed: {...ok, installed: [other.target]},
      };
      for (const [k, input] of Object.entries(cases)) {
        assert.equal(gates.fcDirectWriteGate(input).allowed, false, `${chosen.target} <- ${other.target}: ${k}`);
      }
    }
  });
  it('target matching: the other board manifest entry, image or MSP report is refused', () => {
    for (const [chosen, other] of pairs) {
      assert.ok(gates.fcTargetProblems({chosen, manifestTarget: other.target}).length > 0);
      const img = gates.fcTargetProblems({chosen, imageNames: [other.target]});
      assert.ok(img.some((p) => p.includes(`names ${other.target}`)), img.join(' | '));
      const msp = gates.fcTargetProblems({chosen, reported: {boardName: other.target, targetName: '', manufacturerId: 'OPFC'}});
      assert.ok(msp.some((p) => p.includes(`reports ${other.target}`)), msp.join(' | '));
    }
  });
  it('neither target name contains the other, so the image name scan cannot confuse them', () => {
    assert.equal(MINI.target.includes(LITE.target), false);
    assert.equal(LITE.target.includes(MINI.target), false);
    const has = (text: string) => (n: string) => text.includes(n);
    assert.deepEqual(gates.knownFcNamesIn(has(`xx${LITE.target}\0yy`)), [LITE.target]);
    assert.deepEqual(gates.knownFcNamesIn(has(`xx${MINI.target}\0yy`)), [MINI.target]);
  });
});

describe('OpenESC 30x30: runs the 20x20 image; the page cannot tell them apart', () => {
  const ESC30 = T.escTargetByName('OPENESC_30X30')!;
  it('same MCU and firmware name as the 20x20, so both read the same identity', () => {
    assert.equal(ESC30.firmwareName, ESC20.firmwareName);
    assert.equal(ESC30.mcu, ESC20.mcu);
    assert.deepEqual(gates.knownEscNamesIn(() => true), ['OPENESC_20_F421'], 'deduplicated');
  });
  it('switch ON: a 30x30 that reads OPENESC_20_F421 passes; any other name or chip blocks', () => {
    setup('localhost', ON);
    const base = {
      chosen: ESC30,
      release: fm.releasesFor('OPENESC_30X30')[0]!,
      verifiedFor: ESC30.target,
      mcu: {status: 'ok', value: 'AT32F421'} as const,
      firmwareName: {status: 'ok', value: 'OPENESC_20_F421'} as const,
    };
    assert.deepEqual(gates.escDirectWriteGate(base).reasons, []);
    assert.equal(gates.escDirectWriteGate({...base, firmwareName: {status: 'ok', value: 'OPENESC_30_F421'}}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, firmwareName: {status: 'blank', detail: 'x'}}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, mcu: {status: 'unknown', detail: 'x'}}).allowed, false);
    assert.equal(gates.escDirectWriteGate({...base, release: fm.releasesFor('OPENESC_20_F421')[0]!}).allowed, false);
  });
  it('prepareAm32Image accepts the 20x20 image for the 30x30 and refuses another name', () => {
    const img = prepareAm32Image(app(), ESC30, defaults());
    assert.equal(img.target, 'OPENESC_30X30');
    assert.throws(() => prepareAm32Image(app('OPENESC_30_F421'), ESC30, defaults()), /not for this ESC/);
  });
  it('switch OFF: the 30x30 has no published release', () => {
    setup('opendrone.be', ON);
    assert.ok(fm.releasesFor('OPENESC_30X30').every((r) => !man.isPublished(r)));
  });
});
