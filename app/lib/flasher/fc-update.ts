/**
 * The one-button flight-controller update (/flash), as a stage machine with
 * injected device access so every path is unit-tested.
 *
 *   startUpdate (the "Update firmware" click):
 *     serial  : pick the FC's serial port, identify it over MSP (this decides the board)
 *     check   : download + verify the pinned file for that board
 *     reboot  : Betaflight CLI "#" + "bl rom"
 *     usb     : wait for the RP2350 Boot device. If the browser already permits it, continue
 *               at once; otherwise stop with `need-usb`: the WebUSB picker needs a fresh click
 *               (the original click's activation has expired by now), so the page shows Continue.
 *   continueUpdate (Continue, also the resume path after holding BOOT):
 *     usb     : open the RP2350 Boot device (permitted device or the picker)
 *     check   : chip package + firmware on the board, through fcDirectWriteGate (UNCHANGED gate)
 *     install : flashImage (its own interruption-safe order)
 *     restart : the board reboots into the new firmware
 *
 * Fail closed: a gate refusal ends the flow with nothing written. Any stage
 * failure returns which stage and why; the page then offers BOOT + Continue.
 * The flow never runs while the direct-write gates are off (`gatesOn`).
 */

import {fcDirectWriteGate, fcTargetProblems, type FcGates} from './gates.ts';
import type {FirmwareRelease} from './manifest.ts';
import {pickerErrText, errText, type RebootConnection} from './fc-reboot.ts';
import {chipPackageResult, type ChipInfo, type FlashPhase} from './picoboot.ts';
import {FLASHER_TARGETS, type FlasherTarget} from './targets.ts';
import type {Uf2Image} from './uf2.ts';

export type Stage = 'serial' | 'check' | 'reboot' | 'usb' | 'install' | 'restart';

export const STAGE_TEXT: Record<Stage, string> = {
  serial: "Choose your board's serial port.",
  check: 'Checking the file and the board.',
  reboot: 'Restarting into the bootloader.',
  usb: 'Now choose "RP2350 Boot" in the second window.',
  install: "Installing, {n}%. Don't unplug.",
  restart: 'Restarting the board.',
};
export const DONE_TEXT = 'Done. Reconnect in Betaflight and check your settings.';
export const BOOT_HINT = 'Hold the BOOT button on the board while plugging in USB, then Continue.';
export const GATED_TEXT = 'Direct install is off for now. Use Other ways.';

export type Prepared = {
  target: FlasherTarget;
  release: FirmwareRelease;
  image: Uf2Image;
  bytes: Uint8Array;
  sha256: string;
  fileName: string;
};

/** The part of Picoboot the flow uses. */
export type PicobootLike = {
  chipInfo(): Promise<ChipInfo>;
  exclusive(on: boolean): Promise<void>;
  exitXip(): Promise<void>;
  findInstalledTargets(start: number, end: number): Promise<string[]>;
  flashImage(image: Uf2Image, onProgress: (phase: FlashPhase, done: number, total: number) => void): Promise<void>;
  close(): Promise<void>;
};

export type FlowDeps = {
  /** Direct-write gates on (flags || staging switch). The UI disables the button when false; checked again here. */
  gatesOn: () => boolean;
  openSerial: () => Promise<RebootConnection>;
  prepare: (target: FlasherTarget) => Promise<Prepared>;
  /** An already-permitted RP2350 Boot device once it appears (up to timeoutMs), or null. */
  findBootsel: (timeoutMs: number) => Promise<unknown | null>;
  /** Open that device, or (device = null) ask with the WebUSB picker: needs a click. */
  openPicoboot: (device: unknown | null) => Promise<PicobootLike>;
  onStage: (stage: Stage, percent?: number) => void;
  /** Tests only: the hardware flags as fcDirectWriteGate takes them. The page leaves this unset (constants || staging switch). */
  gates?: FcGates;
};

export type FlowResult =
  | {kind: 'done'}
  | {kind: 'need-usb'; board: FlasherTarget; prepared: Prepared}
  | {kind: 'failed'; stage: Stage; text: string; board: FlasherTarget | null; prepared: Prepared | null}
  | {kind: 'refused'; text: string};

const failed = (stage: Stage, text: string, board: FlasherTarget | null, prepared: Prepared | null): FlowResult => ({
  kind: 'failed',
  stage,
  text,
  board,
  prepared,
});

const short = (t: FlasherTarget) => t.displayName.replace(/ \(.*\)$/, '');

/** "Update firmware": serial → identify → verify the file → bl rom → wait for RP2350 Boot. */
export async function startUpdate(deps: FlowDeps): Promise<FlowResult> {
  if (!deps.gatesOn()) return {kind: 'refused', text: GATED_TEXT};
  deps.onStage('serial');
  let conn: RebootConnection | null = null;
  let board: FlasherTarget | null = null;
  let prepared: Prepared | null = null;
  try {
    try {
      conn = await deps.openSerial();
    } catch (e) {
      return failed('serial', pickerErrText(e), null, null);
    }
    let info;
    try {
      info = await conn.identify();
    } catch (e) {
      return failed('serial', errText(e), null, null);
    }
    const report = {boardName: info.boardName, targetName: info.targetName, manufacturerId: info.manufacturerId};
    board = FLASHER_TARGETS.find((t) => fcTargetProblems({chosen: t, reported: report}).length === 0) ?? null;
    if (!board) {
      return {kind: 'refused', text: `Not installing: this board is ${info.boardName || info.targetName || 'unknown'}, not an OpenFC-Lite or Lite Mini.`};
    }
    deps.onStage('check');
    try {
      prepared = await deps.prepare(board);
    } catch (e) {
      return failed('check', errText(e), board, null);
    }
    deps.onStage('reboot');
    try {
      await conn.rebootToBootloader();
    } catch (e) {
      return failed('reboot', errText(e), board, prepared);
    }
  } finally {
    await conn?.close().catch(() => {});
  }
  deps.onStage('usb');
  const device = await deps.findBootsel(10_000).catch(() => null);
  if (device == null) return {kind: 'need-usb', board, prepared};
  return continueUpdate(deps, {board, prepared, device});
}

/** Continue (or resume after BOOT): open RP2350 Boot → gate → install → restart. */
export async function continueUpdate(
  deps: FlowDeps,
  ctx: {board: FlasherTarget | null; prepared: Prepared | null; device?: unknown | null},
): Promise<FlowResult> {
  if (!deps.gatesOn()) return {kind: 'refused', text: GATED_TEXT};
  const board = ctx.board;
  if (!board) return failed('usb', 'Choose which board it is first.', null, null);
  let prepared = ctx.prepared && ctx.prepared.target.target === board.target ? ctx.prepared : null;
  if (!prepared) {
    deps.onStage('check');
    try {
      prepared = await deps.prepare(board);
    } catch (e) {
      return failed('check', errText(e), board, null);
    }
  }
  deps.onStage('usb');
  let pb: PicobootLike;
  try {
    pb = await deps.openPicoboot(ctx.device ?? null);
  } catch (e) {
    return failed('usb', pickerErrText(e), board, prepared);
  }
  try {
    deps.onStage('check');
    let chip: ChipInfo;
    let installed: string[];
    try {
      chip = await pb.chipInfo();
      await pb.exclusive(true);
      try {
        await pb.exitXip();
        installed = await pb.findInstalledTargets(prepared.image.start, prepared.image.end);
      } finally {
        await pb.exclusive(false).catch(() => {});
      }
    } catch (e) {
      return failed('check', errText(e), board, prepared);
    }
    const pkg = chipPackageResult(chip);
    const gate = fcDirectWriteGate({
      gates: deps.gates,
      chosen: board,
      release: prepared.release,
      verifiedFor: prepared.target.target,
      imageStart: prepared.image.start,
      imageEnd: prepared.image.end,
      chipPackage: pkg,
      flashBytes: chip.flashBytes ?? null,
      installed,
    });
    if (!gate.allowed) return {kind: 'refused', text: refusalText(board, pkg, installed, gate.reasons)};
    deps.onStage('install', 0);
    try {
      await pb.flashImage(prepared.image, (phase, done, total) => {
        if (phase === 'reboot') deps.onStage('restart');
        else deps.onStage('install', Math.round((done / Math.max(1, total)) * 100));
      });
    } catch (e) {
      return failed('install', errText(e), board, prepared);
    }
    deps.onStage('restart');
    return {kind: 'done'};
  } finally {
    await pb.close().catch(() => {});
  }
}

/** One plain line for a gate refusal; the specific wrong-board reasons first. */
export function refusalText(
  chosen: FlasherTarget,
  pkg: ReturnType<typeof chipPackageResult>,
  installed: readonly string[],
  reasons: readonly string[],
): string {
  const other = installed.find((t) => t !== chosen.target);
  if (other) {
    const o = FLASHER_TARGETS.find((t) => t.target === other);
    return `Not installing: this board is ${o ? short(o) : other}, not ${short(chosen)}.`;
  }
  if (pkg.status === 'ok' && pkg.value !== chosen.chipPackage) return `Not installing: the chip doesn't match ${short(chosen)}.`;
  const unknown = reasons.find((r) => r.startsWith("Can't identify the firmware"));
  if (unknown) return unknown;
  return `Not installing: ${reasons.join(' ')}`;
}
