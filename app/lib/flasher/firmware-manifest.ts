/**
 * PINNED firmware manifest for the web flasher (/flash).
 *
 * One entry per product and version. The page offers only what is listed
 * here, and only once `published` is true. To publish a file:
 *   1. copy the exact release file to `public<url>` (same origin: the site's
 *      CSP keeps `connect-src 'self'`);
 *   2. set `size` and `sha256` from that copy (`sha256sum`, lowercase hex);
 *   3. set `published: true` in the same reviewed PR.
 * The browser re-hashes every download with crypto.subtle and refuses any
 * byte difference.
 *
 * Status (2026-11-02):
 *   - OpenFC-Lite / Lite Mini: hashes and sizes are of the rev3.3 UF2s in the
 *     board repos' `firmware/` folders. Not hosted on opendrone.be yet, so
 *     `published: false`.
 *   - OpenESC-20x20: no AM32 release file exists yet. Placeholder.
 */

import {PLACEHOLDER_SHA256, type FirmwareRelease} from './manifest.ts';

export const FIRMWARE_MANIFEST: readonly FirmwareRelease[] = [
  {
    target: 'OPENFC_LITE_RP2350B',
    kind: 'betaflight-uf2',
    version: 'rev3.3',
    firmware: 'Betaflight 2026.6.0-alpha',
    channel: 'stable',
    released: '2026-08-25',
    url: '/firmware/openfc/OpenFC-Lite-rev3.3_betaflight_2026.6.0-alpha_OPENFC_LITE_RP2350B.uf2',
    size: 868352,
    sha256: '4dbd52d8aebe68dcb1134a65a7da4d3137e41ef19c30addd418e3ef2dcfcd581',
    published: false,
    notes: 'From OpenDrone-hw/OpenFC-Lite firmware/. Publish by hosting the file at url.',
  },
  {
    target: 'OPENFC_LITE_MINI_RP2350A',
    kind: 'betaflight-uf2',
    version: 'rev3.3',
    firmware: 'Betaflight 2026.12.0-alpha (0b1c266, config 9eada21)',
    channel: 'stable',
    released: '2026-08-25',
    url: '/firmware/openfc/OpenFC-Lite-Mini-rev3.3_betaflight_2026.12.0-alpha-0b1c266_cfg-9eada21_OPENFC_LITE_MINI_RP2350A.uf2',
    size: 897536,
    sha256: '555f9ff49a374a0531c7d90cfb5ea4abee7dc82d7e3092c5bba98b667241660a',
    published: false,
    notes: 'From OpenDrone-hw/OpenFC-Lite-Mini firmware/. Publish by hosting the file at url.',
  },
  {
    target: 'OPENESC_20_F421',
    kind: 'am32-hex',
    version: 'PLACEHOLDER',
    firmware: 'AM32 (OpenDrone fork, OPENESC_20_F421)',
    channel: 'stable',
    released: 'PLACEHOLDER',
    url: null,
    size: 0,
    sha256: PLACEHOLDER_SHA256,
    published: false,
    notes: 'PLACEHOLDER: no AM32 release file for OpenESC-20x20 exists yet.',
  },
];

export function releasesFor(target: string): FirmwareRelease[] {
  return FIRMWARE_MANIFEST.filter((r) => r.target === target);
}
