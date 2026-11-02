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

import {PLACEHOLDER_SHA256, type FirmwareKind, type FirmwareRelease} from './manifest.ts';

export type FirmwareChannel = FirmwareRelease['channel'];

/** One pinned release asset. */
export type FirmwarePin = {
  version: string;
  url: string;
  sha256: string;
  size: number;
  channel: FirmwareChannel;
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
    kind: b.kind,
    version: pin.version,
    firmware: b.firmware,
    channel: pin.channel,
    released: '',
    url: pin.url,
    size: pin.size,
    sha256: pin.sha256,
    published: true,
  };
}

export const FIRMWARE_MANIFEST: readonly FirmwareRelease[] = (Object.keys(PINNED) as PinnedTarget[]).map((t) =>
  pinToRelease(t, PINNED[t]),
);

export function releasesFor(target: string): FirmwareRelease[] {
  return FIRMWARE_MANIFEST.filter((r) => r.target === target);
}
