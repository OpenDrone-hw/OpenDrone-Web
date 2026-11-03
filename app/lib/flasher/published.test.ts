import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {FIRMWARE_MANIFEST, PINNED, pinToRelease, type FirmwarePin, type PinnedTarget} from './firmware-manifest.ts';
import {isPublished} from './manifest.ts';
import {firmwareIdText, tierFirmwarePublished, tierFirmwareTarget} from './published.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const goodPin: FirmwarePin = {
  version: 'v1.0.0',
  url: 'https://github.com/OpenDrone-hw/OpenFC-Lite/releases/download/v1.0.0/fw.uf2',
  sha256: 'ab'.repeat(32),
  size: 76543,
  channel: 'alpha',
};

/** The production manifest with one board pinned. */
const withPin = (target: PinnedTarget) =>
  (Object.keys(PINNED) as PinnedTarget[]).map((t) => pinToRelease(t, t === target ? goodPin : PINNED[t]));

test('every PDP tier maps to a known manifest target', () => {
  const targets = new Set(FIRMWARE_MANIFEST.map((r) => r.target));
  for (const handle of ['openfc-lite', 'openesc']) {
    for (const tier of ['20×20', '20x20', '30×30', ' 30x30 ']) {
      const t = tierFirmwareTarget(handle, tier);
      assert.ok(t && targets.has(t), `${handle} ${tier}`);
    }
  }
  assert.equal(tierFirmwareTarget('openfc-lite', '20×20'), 'OPENFC_LITE_MINI_RP2350A');
  assert.equal(tierFirmwareTarget('openfc-lite', '30×30'), 'OPENFC_LITE_RP2350B');
  assert.equal(tierFirmwareTarget('openframe', '20×20'), null);
  assert.equal(tierFirmwareTarget('openfc-lite', 'Mono'), null);
});

test('the PDP link follows the manifest: nothing published today, so no tier shows "Flash firmware"', () => {
  for (const handle of ['openfc-lite', 'openesc']) {
    for (const tier of ['20×20', '30×30']) {
      const t = tierFirmwareTarget(handle, tier)!;
      assert.equal(
        tierFirmwarePublished(handle, tier),
        FIRMWARE_MANIFEST.some((r) => r.target === t && isPublished(r)),
        `${handle} ${tier}`,
      );
    }
  }
});

test('publishing one board lights up exactly its tier (e.g. the Lite = 30×30)', () => {
  const m = withPin('OPENFC_LITE_RP2350B');
  assert.equal(tierFirmwarePublished('openfc-lite', '30×30', m), true);
  assert.equal(tierFirmwarePublished('openfc-lite', '20×20', m), false);
  assert.equal(tierFirmwarePublished('openesc', '30×30', m), false);
  const esc = withPin('OPENESC_20_F421');
  assert.equal(tierFirmwarePublished('openesc', '20×20', esc), true);
  assert.equal(tierFirmwarePublished('openesc', '30×30', esc), false);
  assert.equal(tierFirmwarePublished('openfc-lite', '20×20', esc), false);
});

test('PDP route: link gated on tierFirmwarePublished, no hard-coded tier', () => {
  const src = read('../../routes/products.$handle.tsx');
  assert.match(src, /tierFirmwarePublished\(product\.handle, activeTier\) \?/);
  assert.doesNotMatch(src, /\/\^20\/\.test\(activeTier/);
  assert.match(src, /product-chrome\.firmware_flash_unavailable/);
});

test('firmwareIdText: version + 7-char SHA, each only when present', () => {
  assert.equal(firmwareIdText({version: '2026.12.0-alpha', sha256: 'cf94838a'.padEnd(64, '0')}), '2026.12.0-alpha, SHA-256 cf94838');
  assert.equal(firmwareIdText({version: '', sha256: 'ab'.repeat(32)}), 'SHA-256 abababa');
  assert.equal(firmwareIdText({version: 'v1', sha256: ''}), 'v1');
  assert.equal(firmwareIdText({version: '', sha256: 'nope'}), '');
});
