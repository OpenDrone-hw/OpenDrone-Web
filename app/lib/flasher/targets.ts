/**
 * The boards the web flasher knows. This list is the allowlist: a manifest
 * entry whose target is not here is dropped, so a bad manifest cannot add a
 * board the page was never reviewed for.
 *
 * Identity facts come from the public Betaflight configs
 * (OpenDrone-hw/betaflight-config, configs/OPENFC_LITE_*_RP2350{A,B}/config.h):
 * BOARD_NAME and MANUFACTURER_ID are what MSP_BOARD_INFO reports while
 * Betaflight runs, and the target name string is compiled into the image.
 *
 * RP2354A = RP2350A die (QFN-60) + 2 MB stacked flash; RP2354B = RP2350B
 * (QFN-80) + 2 MB. Betaflight names the targets after the die (RP2350A/B).
 */

import {stagingBenchEnabled} from './staging.ts';
import {UF2_FAMILY} from './uf2.ts';

export type ChipPackage = 'QFN60' | 'QFN80';

export type FlasherTarget = {
  /** Betaflight target / BOARD_NAME, e.g. OPENFC_LITE_MINI_RP2350A. */
  target: string;
  manufacturerId: string;
  product: string;
  displayName: string;
  /** RP2350 package the board uses: lets the bootloader rule out the other board family. */
  chipPackage: ChipPackage;
  uf2Family: number;
  flashSize: number;
};

export const FLASHER_TARGETS: readonly FlasherTarget[] = [
  {
    target: 'OPENFC_LITE_MINI_RP2350A',
    manufacturerId: 'OPFC',
    product: 'openfc-lite-mini',
    displayName: 'OpenFC-Lite Mini (RP2354A)',
    chipPackage: 'QFN60',
    uf2Family: UF2_FAMILY.RP2350_ARM_S,
    flashSize: 2 * 1024 * 1024,
  },
  {
    target: 'OPENFC_LITE_RP2350B',
    manufacturerId: 'OPFC',
    product: 'openfc-lite',
    displayName: 'OpenFC-Lite (RP2354B)',
    chipPackage: 'QFN80',
    uf2Family: UF2_FAMILY.RP2350_ARM_S,
    flashSize: 2 * 1024 * 1024,
  },
] as const;

export function targetByName(name: string): FlasherTarget | undefined {
  return FLASHER_TARGETS.find((t) => t.target === name);
}

/**
 * ESC targets (AM32). `target` is the page's key for the ESC: AM32's
 * FILE_NAME (the release file name) where the ESC has its own AM32 target.
 * `firmwareName` is the identity string the flasher reads back from the ESC
 * and from the image: the AM32 name slot at flash 0x08007BE0, which holds
 * FILE_NAME, NUL padded (derivation in am32-layout.ts, AM32_NAME_SLOT_OFFSET).
 * It is NOT AM32's FIRMWARE_NAME ("OpenESC_20"): that string is not in the
 * built app, and EEPROM bytes 5..16 are settings in EEPROM v4. Source: OpenDrone
 * AM32 fork (branch feat/openesc-20-target, Inc/targets.h, OPENESC_20_F421).
 *
 * OpenESC-30x30 has no AM32 target of its own. Its QC bed flashed the same
 * three images as the 20x20 (bootloader V17, AM32 2.21 OPENESC_20_F421, EEPROM
 * v4 defaults; esc-qc.csv, 2026-10-31), so it runs OPENESC_20_F421 and its name
 * slot reads exactly that. `OPENESC_30X30` is a page key only, not an AM32
 * target. The flasher therefore CANNOT tell a 20x20 from a 30x30: same MCU,
 * same bootloader signature, same name slot. Choosing the wrong one installs
 * the identical image, which is harmless while both share it. Give the 30x30
 * its own firmwareName once it gets its own AM32 target.
 */
export type EscMcu = 'AT32F421';

export type EscTarget = {
  target: string;
  firmwareName: string;
  product: string;
  displayName: string;
  mcu: EscMcu;
  /** Shown as "Coming soon" (not selectable) until a published release exists for it. */
  comingSoonUntilPinned?: boolean;
};

export const ESC_TARGETS: readonly EscTarget[] = [
  {
    target: 'OPENESC_20_F421',
    firmwareName: 'OPENESC_20_F421',
    product: 'openesc-20x20',
    displayName: 'OpenESC-20x20 (AT32F421)',
    mcu: 'AT32F421',
  },
  {
    target: 'OPENESC_30X30',
    firmwareName: 'OPENESC_20_F421',
    product: 'openesc-30x30',
    displayName: 'OpenESC-30x30 (AT32F421)',
    mcu: 'AT32F421',
    comingSoonUntilPinned: true,
  },
] as const;

export function escTargetByName(name: string): EscTarget | undefined {
  return ESC_TARGETS.find((t) => t.target === name);
}

/**
 * HARDWARE-VERIFY GATES for the direct (PICOBOOT) write. Both must be true
 * before the page will ever write flash itself; while either is false the
 * only install path is the verified UF2 download + drag-and-drop copy, with
 * no override checkbox. Flip them only in a reviewed PR that records the
 * hardware evidence.
 *
 * CHIP_PACKAGE_VERIFIED: GET_INFO SYS CHIP_INFO `package_sel` polarity
 * (assumed bit0=1 -> QFN60) and the response word layout come from
 * documentation, not hardware. Confirm with `picotool info -a` on an RP2354A
 * (Mini) and an RP2354B (Lite) board. A wrong polarity would pass the wrong
 * board, so the package is advisory text until then.
 *
 * PICOBOOT_WRITE_VERIFIED: the write sequence itself (EXCLUSIVE_ACCESS,
 * EXIT_XIP before READ, read-back returning fresh data rather than XIP cache,
 * Betaflight's IMAGE_DEF in sector 0 with no partition table, WinUSB binding
 * on Windows). See review-flash-write-safety.md, "Hardware-verify list".
 */
export const CHIP_PACKAGE_VERIFIED = false;
export const PICOBOOT_WRITE_VERIFIED = false;

/**
 * The two flags as the code must read them: each constant OR the staging
 * bench switch (staging.ts). Every check of CHIP_PACKAGE_VERIFIED /
 * PICOBOOT_WRITE_VERIFIED goes through here (or through the same
 * `CONST || stagingBenchEnabled()`); the constants stay false. With a
 * release, a per-board DIRECT_INSTALL_VERIFIED entry for that exact target +
 * SHA-256 also counts. This replaces only the "unverified on hardware" flags,
 * never the target or package match.
 */
export function effectiveFcGates(release?: VerifiedRef | null): {CHIP_PACKAGE_VERIFIED: boolean; PICOBOOT_WRITE_VERIFIED: boolean} {
  const on = stagingBenchEnabled() || boardDirectInstallVerified(release);
  return {
    CHIP_PACKAGE_VERIFIED: CHIP_PACKAGE_VERIFIED || on,
    PICOBOOT_WRITE_VERIFIED: PICOBOOT_WRITE_VERIFIED || on,
  };
}

/**
 * PER-BOARD hardware evidence for the direct (PICOBOOT) write, keyed by
 * target and tied to the exact pinned image SHA-256. It stands in for BOTH
 * global flags above, but only for a release whose target AND sha256 equal an
 * entry here: a new pin (different SHA) is unverified again until a reviewed
 * PR adds its evidence. Boards without an entry (the Lite Mini, the ESCs)
 * stay copy-only. It never replaces the target, chip-package, installed-
 * firmware, size or hash checks (fcDirectWriteGate, gates.ts).
 */
export const DIRECT_INSTALL_VERIFIED: Readonly<Partial<Record<string, {sha256: string; evidence: string}>>> = {
  OPENFC_LITE_RP2350B: {
    sha256: 'cf94838a4207f89c196ff3ba5c4e0136eb6e9920eb68033876b90c0b6f4b4196',
    evidence:
      'Bench 2026-11-02: real OpenFC-Lite, one-button flow (staging c932382, Chrome macOS); afterwards Betaflight RP2350B 2026.12.0-alpha d593400a0, OPENFC_LITE_RP2350B.',
  },
};

/** The fields of a release the per-board check reads. */
export type VerifiedRef = {target: string; sha256: string};

/** True only if this exact (target, sha256) has recorded hardware evidence. */
export function boardDirectInstallVerified(release: VerifiedRef | null | undefined): boolean {
  if (!release) return false;
  const v = Object.hasOwn(DIRECT_INSTALL_VERIFIED, release.target) ? DIRECT_INSTALL_VERIFIED[release.target] : undefined;
  return !!v && v.sha256 === release.sha256;
}

/** USB IDs. */
export const RPI_VID = 0x2e8a;
/** RP2350 bootrom in BOOTSEL (mass storage + PICOBOOT vendor interface). */
export const RP2350_BOOTSEL_PID = 0x000f;

/**
 * Whether the document's Permissions-Policy allows a feature. The site sends
 * `usb=()` / `serial=()` everywhere except /flash, and a client-side
 * navigation keeps the previous document's policy, so the page checks.
 */
export function policyAllows(feature: 'usb' | 'serial'): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as Document & {
    permissionsPolicy?: {allowsFeature(f: string): boolean};
    featurePolicy?: {allowsFeature(f: string): boolean};
  };
  const policy = d.permissionsPolicy ?? d.featurePolicy;
  return policy ? policy.allowsFeature(feature) : true;
}
