/**
 * PINNED firmware manifest for the web flasher (/flash).
 *
 * Publishing a release file for a board is a ONE-LINE change: replace that
 * board's `null` in PINNED with
 *   {version, url, sha256, size, channel}
 * where
 *   - url    = the GitHub release asset, https://github.com/OpenDrone-hw/<repo>/releases/download/<tag>/<file>
 *              (or a host added explicitly to FIRMWARE_URL_ALLOWLIST in manifest.ts);
 *   - sha256 = `sha256sum` of that exact asset, 64 lowercase hex;
 *   - size   = its size in bytes;
 *   - channel = 'alpha' | 'beta' | 'stable'. Never mark an alpha 'stable' (F11).
 * An entry the page will offer must pass isPublished(): allowlisted https URL,
 * 64-hex SHA-256, positive size, non-empty version. Anything else (including
 * null) stays "firmware not published yet". The browser re-hashes every
 * download with crypto.subtle and refuses any byte difference.
 * Before the first pin: the CSP connect-src (app/lib/csp.ts) must allow the
 * download host, and the host must serve the asset to a browser fetch (CORS).
 *
 * Status (2026-11-02): nothing pinned. No OpenDrone-hw release carries a
 * firmware asset yet (all releases hold schematics/fab files only).
 *   - OpenFC-Lite / Lite Mini: the rev3.3 Betaflight ALPHA UF2s live only in
 *     the board repos' `firmware/` folders, not as release assets. Candidates
 *     (not pinned): Lite 2026.6.0-alpha, 868352 B, sha256 4dbd52d8...cfcd581;
 *     Mini 2026.12.0-alpha 0b1c266/cfg 9eada21, 897536 B, sha256 555f9ff4...241660a.
 *     Pin them as channel 'alpha' once they are attached to a release.
 *   - OpenESC-20x20: no public AM32 build exists yet.
 */

import {PLACEHOLDER_SHA256, type FirmwareKind, type FirmwareRelease, type PinnedAsset} from './manifest.ts';
import {stagingBenchEnabled} from './staging.ts';

export type FirmwareChannel = FirmwareRelease['channel'];

/** One pinned release asset. */
export type FirmwarePin = {
  version: string;
  url: string;
  sha256: string;
  size: number;
  channel: FirmwareChannel;
  /** Overrides the board's file kind (the staging ESC app is a raw .bin). */
  kind?: FirmwareKind;
  /** AM32: the pinned EEPROM v4 defaults written after the app. */
  eepromDefaults?: PinnedAsset;
};

/** Fixed facts per board; the pin carries everything that changes per release. */
type BoardFirmware = {kind: FirmwareKind; firmware: string; channelWhileUnpinned: FirmwareChannel; notes: string};

const BOARDS = {
  OPENFC_LITE_RP2350B: {
    kind: 'betaflight-uf2',
    firmware: 'Betaflight (OPENFC_LITE_RP2350B)',
    channelWhileUnpinned: 'alpha',
    notes: 'Betaflight alpha build; no release asset yet (board repo firmware/ only).',
  },
  OPENFC_LITE_MINI_RP2350A: {
    kind: 'betaflight-uf2',
    firmware: 'Betaflight (OPENFC_LITE_MINI_RP2350A)',
    channelWhileUnpinned: 'alpha',
    notes: 'Betaflight alpha build; no release asset yet (board repo firmware/ only).',
  },
  OPENESC_20_F421: {
    kind: 'am32-hex',
    firmware: 'AM32 (OpenDrone fork, OPENESC_20_F421)',
    channelWhileUnpinned: 'stable',
    notes: 'No public AM32 build for OpenESC-20x20 yet.',
  },
} as const satisfies Record<string, BoardFirmware>;

export type PinnedTarget = keyof typeof BOARDS;

// ---------------------------------------------------------------------------
// PINNED: one line per board. null = not published.
// ---------------------------------------------------------------------------
export const PINNED: Readonly<Record<PinnedTarget, FirmwarePin | null>> = {
  OPENFC_LITE_RP2350B: null,
  OPENFC_LITE_MINI_RP2350A: null,
  OPENESC_20_F421: null,
};

/**
 * Turn a pin (or null) into a manifest entry. A null pin gives a placeholder;
 * a non-null pin is marked published, but the page still only offers it if
 * isPublished() accepts every field.
 */
export function pinToRelease(target: PinnedTarget, pin: FirmwarePin | null): FirmwareRelease {
  const b: BoardFirmware = BOARDS[target];
  if (!pin) {
    return {
      target,
      kind: b.kind,
      version: 'not published',
      firmware: b.firmware,
      channel: b.channelWhileUnpinned,
      released: '',
      url: null,
      size: 0,
      sha256: PLACEHOLDER_SHA256,
      published: false,
      notes: b.notes,
    };
  }
  return {
    target,
    kind: pin.kind ?? b.kind,
    version: pin.version,
    firmware: b.firmware,
    channel: pin.channel,
    released: '',
    url: pin.url,
    size: pin.size,
    sha256: pin.sha256,
    published: true,
    ...(pin.eepromDefaults ? {eepromDefaults: pin.eepromDefaults} : {}),
  };
}

/**
 * STAGING bench files, fetched from the page's own origin under
 * /firmware-staging/. They are NOT static assets (review 3, F1/F2): the bench
 * Worker serves them from a local R2 binding behind the staging basic auth
 * (staging-serve.ts, wrangler.bench.toml); the build fails if
 * public/firmware-staging/ exists. Source copies live in .firmware-staging/
 * (git-ignored). Used ONLY while stagingBenchEnabled() (staging.ts); otherwise
 * they do not exist for the page. The GitHub draft releases cannot be created yet.
 * OpenFC-Lite and OpenESC-30x30 have no entry here: "not yet available".
 */
export const STAGING_PINNED: Readonly<Partial<Record<PinnedTarget, FirmwarePin>>> = {
  OPENFC_LITE_MINI_RP2350A: {
    version: '2026.12.0-alpha (d593400 + cfg a2b6666)',
    url: '/firmware-staging/OpenFC-Lite-Mini_betaflight-2026.12.0-alpha-d593400_cfg-a2b6666_OPENFC_LITE_MINI_RP2350A.uf2',
    sha256: '75dca15360c94c168b6fb81c58ae4ebb0432be64155e6e2afdbf4197288ea457',
    size: 897536,
    channel: 'alpha',
  },
  OPENESC_20_F421: {
    version: '2.21',
    url: '/firmware-staging/OpenESC-20x20_AM32_OPENESC_20_F421_2.21.bin',
    sha256: '24ed68c8d0e6eb3b9f0f0cd3713cb08397a805cf9a2450d9254d818c457c3b66',
    size: 27648,
    channel: 'alpha',
    kind: 'am32-bin',
    eepromDefaults: {
      url: '/firmware-staging/OpenESC-20x20_AM32_EEPROM_DEFAULT_v4.bin',
      sha256: '8e5cd69bc32e07154e9866ca737ee53a9d5b134059934fbfd9c3df664e2b1fa6',
      size: 192,
    },
  },
};

/** The production manifest: PINNED only. Never includes a staging entry. */
export const FIRMWARE_MANIFEST: readonly FirmwareRelease[] = (Object.keys(PINNED) as PinnedTarget[]).map((t) =>
  pinToRelease(t, PINNED[t]),
);

/** The manifest the page uses: PINNED, with the staging bench entries replacing it only while the switch is on. */
export function currentManifest(): readonly FirmwareRelease[] {
  if (!stagingBenchEnabled()) return FIRMWARE_MANIFEST;
  return (Object.keys(PINNED) as PinnedTarget[]).map((t) => pinToRelease(t, STAGING_PINNED[t] ?? PINNED[t]));
}

export function releasesFor(target: string): FirmwareRelease[] {
  return currentManifest().filter((r) => r.target === target);
}
