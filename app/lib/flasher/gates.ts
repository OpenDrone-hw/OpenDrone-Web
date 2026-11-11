/**
 * Every decision about whether the page may write firmware, as pure
 * functions, so the rules are unit-tested and the UI only renders them.
 *
 * Fail-closed: anything unread, unknown, blank or mismatched blocks, every
 * hardware-verify flag that is false blocks, and there is no override input.
 * The only thing that stands in for a hardware-verify flag is the staging
 * bench switch (staging.ts, build-time env + host check): `flag || stagingBenchEnabled()`.
 * It never replaces a target, MCU, name, chip-package, size or hash check.
 * When a direct write is blocked, the fallback is always the verified file:
 * UF2 copy for the FC, esc-configurator.com for the ESC.
 */

import {AM32_GATES, type Am32Gates} from './am32-layout.ts';
import {isPublished, type FirmwareRelease} from './manifest.ts';
import {stagingBenchEnabled} from './staging.ts';
import {
  boardDirectInstallVerified,
  CHIP_PACKAGE_VERIFIED,
  ESC_TARGETS,
  FLASHER_TARGETS,
  PICOBOOT_WRITE_VERIFIED,
  type ChipPackage,
  type EscMcu,
  type EscTarget,
  type FlasherTarget,
} from './targets.ts';

export type GateResult = {allowed: boolean; reasons: string[]};

const result = (reasons: string[]): GateResult => ({allowed: reasons.length === 0, reasons});

/** A value read from hardware: either read and understood, or why not. */
export type ReadResult<T> =
  | {status: 'ok'; value: T}
  | {status: 'unreadable' | 'unknown' | 'blank'; detail: string};

// ---------------------------------------------------------------------------
// Target matching: chosen board vs MSP report vs image vs manifest entry.
// ---------------------------------------------------------------------------

export type MspReport = {boardName: string; targetName: string; manufacturerId: string};

/**
 * Hard target-mismatch check for the flight controller. Returns the
 * problems; empty means every source that is present names `chosen`.
 *  - manifest entry target must equal the chosen board;
 *  - the image must name the chosen target and no other known OpenFC target;
 *  - an MSP report, when present, must come from the same manufacturer and
 *    name the chosen target, and must not name a different known target.
 */
export function fcTargetProblems(input: {
  chosen: FlasherTarget;
  manifestTarget?: string;
  imageNames?: readonly string[];
  reported?: MspReport | null;
}): string[] {
  const {chosen} = input;
  const problems: string[] = [];
  if (input.manifestTarget !== undefined && input.manifestTarget !== chosen.target) {
    problems.push(`The firmware entry is for ${input.manifestTarget}, not ${chosen.target}.`);
  }
  if (input.imageNames !== undefined) {
    if (!input.imageNames.includes(chosen.target)) {
      problems.push(`The file does not contain the target name ${chosen.target}; it is not for this board.`);
    }
    const others = input.imageNames.filter((n) => n !== chosen.target);
    if (others.length) problems.push(`The file names ${others.join(', ')}; refusing an image for another board.`);
  }
  if (input.reported) {
    const r = input.reported;
    const names = [r.boardName, r.targetName].filter(Boolean);
    const otherKnown = names.find((n) => n !== chosen.target && FLASHER_TARGETS.some((t) => t.target === n));
    if (r.manufacturerId !== chosen.manufacturerId) {
      problems.push(`The connected board is from "${r.manufacturerId}", not an OpenDrone board.`);
    }
    if (otherKnown) {
      problems.push(`The connected board reports ${otherKnown}, but you chose ${chosen.target}.`);
    } else if (!names.includes(chosen.target)) {
      problems.push(`The connected board reports "${r.boardName || r.targetName || 'nothing'}", not ${chosen.target}.`);
    }
  }
  return problems;
}

/** Which known FC target names a predicate finds in an image. */
export function knownFcNamesIn(contains: (name: string) => boolean): string[] {
  return FLASHER_TARGETS.map((t) => t.target).filter(contains);
}

/** Same for ESC identity names (the AM32 name slot string, EscTarget.firmwareName), each once (two ESCs can share one). */
export function knownEscNamesIn(contains: (name: string) => boolean): string[] {
  return [...new Set(ESC_TARGETS.map((t) => t.firmwareName))].filter(contains);
}

export function escTargetProblems(input: {
  chosen: EscTarget;
  manifestTarget?: string;
  imageNames?: readonly string[];
  escFirmwareName?: ReadResult<string>;
  escMcu?: ReadResult<EscMcu>;
}): string[] {
  const {chosen} = input;
  const problems: string[] = [];
  if (input.manifestTarget !== undefined && input.manifestTarget !== chosen.target) {
    problems.push(`The firmware entry is for ${input.manifestTarget}, not ${chosen.target}.`);
  }
  if (input.imageNames !== undefined) {
    if (!input.imageNames.includes(chosen.firmwareName)) {
      problems.push(`The file does not contain the firmware name ${chosen.firmwareName}; it is not for this ESC.`);
    }
    const others = input.imageNames.filter((n) => n !== chosen.firmwareName);
    if (others.length) problems.push(`The file names ${others.join(', ')}; refusing an image for another ESC.`);
  }
  if (input.escMcu) {
    const m = input.escMcu;
    if (m.status !== 'ok') problems.push(`ESC chip: ${m.status} (${m.detail}).`);
    else if (m.value !== chosen.mcu) problems.push(`The ESC chip is ${m.value}, but ${chosen.displayName} uses ${chosen.mcu}.`);
  }
  if (input.escFirmwareName) {
    const f = input.escFirmwareName;
    if (f.status !== 'ok') problems.push(`ESC firmware name: ${f.status} (${f.detail}).`);
    else if (f.value !== chosen.firmwareName) {
      problems.push(`The ESC runs firmware named "${f.value}", but ${chosen.displayName} needs "${chosen.firmwareName}".`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Flight controller: direct PICOBOOT write.
// ---------------------------------------------------------------------------

export type FcGates = {CHIP_PACKAGE_VERIFIED: boolean; PICOBOOT_WRITE_VERIFIED: boolean};
export const FC_GATES: FcGates = {CHIP_PACKAGE_VERIFIED, PICOBOOT_WRITE_VERIFIED};

export type FcDirectWriteInput = {
  gates?: FcGates;
  chosen: FlasherTarget;
  release: FirmwareRelease;
  /** Target the verified image was prepared for (null = nothing verified). */
  verifiedFor: string | null;
  imageStart: number;
  imageEnd: number;
  /** Chip package from GET_INFO. Must be 'ok' and equal to the target's package. */
  chipPackage: ReadResult<ChipPackage> | null;
  flashBytes: number | null;
  /** Known target names found in the firmware currently on the board (null = not scanned). */
  installed: readonly string[] | null;
};

/**
 * The direct-write gate. Allowed only if BOTH hardware flags are true (or the
 * staging switch, or a DIRECT_INSTALL_VERIFIED entry for this board's pinned SHA-256), the
 * release is published, the verified image belongs to the chosen board, the
 * chip package was read and matches, the image fits, and the firmware on the
 * board names exactly this target. Otherwise: copy method only.
 */
export function fcDirectWriteGate(i: FcDirectWriteInput): GateResult {
  const gates = i.gates ?? FC_GATES;
  // Per-board evidence (targets.ts DIRECT_INSTALL_VERIFIED) counts only for the chosen board's own pinned image.
  const board = i.release.target === i.chosen.target && boardDirectInstallVerified(i.release);
  const staging = stagingBenchEnabled() || board;
  const reasons: string[] = [];
  if (!(gates.CHIP_PACKAGE_VERIFIED || staging)) reasons.push('Chip package detection is not verified on hardware yet (CHIP_PACKAGE_VERIFIED=false).');
  if (!(gates.PICOBOOT_WRITE_VERIFIED || staging)) reasons.push('The direct write sequence is not verified on hardware yet (PICOBOOT_WRITE_VERIFIED=false).');
  if (!isPublished(i.release)) reasons.push('Firmware not published yet.');
  if (i.verifiedFor !== i.chosen.target) reasons.push('The verified file is not for the chosen board. Download it again.');
  if (i.release.target !== i.chosen.target) reasons.push(`The firmware entry is for ${i.release.target}, not ${i.chosen.target}.`);
  const pkg = i.chipPackage;
  if (!pkg) reasons.push('Chip package not read.');
  else if (pkg.status !== 'ok') reasons.push(`Chip package ${pkg.status}: ${pkg.detail}.`);
  else if (pkg.value !== i.chosen.chipPackage) {
    reasons.push(`Chip package ${pkg.value} does not match ${i.chosen.displayName} (${i.chosen.chipPackage}).`);
  }
  const limit = Math.min(i.chosen.flashSize, i.flashBytes ?? i.chosen.flashSize);
  if (i.imageEnd - i.imageStart > limit) reasons.push('The image is larger than the board flash.');
  if (i.installed === null) reasons.push('The firmware on the board has not been read.');
  else {
    const other = i.installed.find((t) => t !== i.chosen.target);
    if (other) reasons.push(`The board currently runs firmware for ${other}.`);
    else if (!i.installed.includes(i.chosen.target)) {
      reasons.push(
        `Can't identify the firmware on this board. If you're sure it's an ${i.chosen.displayName.replace(/ \(.*\)$/, '')}, use the copy method (Other ways).`,
      );
    }
  }
  return result(reasons);
}

/**
 * F3: whether the DirectInstall button is enabled. Never while a (re)connect
 * is in progress, so a gate result computed from the previous board's chip and
 * scan can never be combined with a newly opened device.
 */
export function fcInstallEnabled(i: {
  gate: GateResult;
  connected: boolean;
  connecting: boolean;
  battery: boolean;
  flashing: boolean;
  finished: boolean;
}): boolean {
  return i.gate.allowed && i.connected && !i.connecting && i.battery && !i.flashing && !i.finished;
}

// ---------------------------------------------------------------------------
// ESC: direct 4-way write.
// ---------------------------------------------------------------------------

export type EscDirectWriteInput = {
  gates?: Am32Gates;
  chosen: EscTarget;
  release: FirmwareRelease;
  /** Target the verified image was prepared for (null = nothing verified). */
  verifiedFor: string | null;
  /** From the bootloader signature (cmd_DeviceInitFlash). */
  mcu: ReadResult<EscMcu> | null;
  /** From the AM32 name slot at flash 0x08007BE0 (am32-layout.ts AM32_NAME_SLOT_OFFSET). */
  firmwareName: ReadResult<string> | null;
};

/**
 * The ESC direct-write gate. Allowed only if every AM32_*_VERIFIED flag is
 * true, the release is published, the verified image is for the chosen ESC,
 * and BOTH the MCU (bootloader signature) and the name slot (flash 0x08007BE0) were
 * read and match the pinned target. Otherwise: esc-configurator fallback.
 */
export function escDirectWriteGate(i: EscDirectWriteInput): GateResult {
  const gates = i.gates ?? AM32_GATES;
  const staging = stagingBenchEnabled();
  const reasons: string[] = [];
  for (const [name, ok] of Object.entries(gates)) {
    if (!(ok || staging)) reasons.push(`${name}=false: not verified on hardware yet.`);
  }
  if (!isPublished(i.release)) reasons.push('Firmware not published yet.');
  if (i.verifiedFor !== i.chosen.target) reasons.push('The verified file is not for the chosen ESC. Download it again.');
  if (i.release.target !== i.chosen.target) reasons.push(`The firmware entry is for ${i.release.target}, not ${i.chosen.target}.`);
  if (!i.mcu) reasons.push('ESC chip not read.');
  if (!i.firmwareName) reasons.push('ESC firmware name not read.');
  reasons.push(
    ...escTargetProblems({chosen: i.chosen, escMcu: i.mcu ?? undefined, escFirmwareName: i.firmwareName ?? undefined}),
  );
  return result(reasons);
}
