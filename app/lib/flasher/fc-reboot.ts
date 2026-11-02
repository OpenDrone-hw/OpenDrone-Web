/**
 * "Restart board into bootloader" (/flash step 3) as a plain async function, so
 * every path is unit-tested and none of them ends silently: each returns a
 * status the page shows. The port comes from Web Serial's picker
 * (MspConnection.request → navigator.serial.requestPort), inside the click.
 *
 * Fail-closed as before: the board must answer MSP and name the chosen target
 * (fcTargetProblems), or nothing is sent. Restarting into the boot ROM writes
 * nothing; it is not a write gate.
 */

import {fcTargetProblems, type MspReport} from './gates.ts';
import {MspConnection, type BoardInfo} from './msp.ts';
import type {FlasherTarget} from './targets.ts';

export type RebootResult = {kind: 'ok' | 'error'; text: string};

/** The part of MspConnection this flow uses. */
export type RebootConnection = {
  identify(): Promise<BoardInfo>;
  rebootToBootloader(): Promise<void>;
  close(): Promise<void>;
};

export const REBOOT_SENT_TEXT =
  'Restart command sent. If a drive named RP2350 appears, the board is in bootloader mode. If it restarts into Betaflight instead, hold BOOT while plugging in USB.';

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Only for device-picker errors: there NotFoundError means "nothing chosen". Elsewhere it means unplugged (R4). */
export function pickerErrText(e: unknown): string {
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'NotFoundError') return 'No device was selected.';
  return errText(e);
}

const toReport = (info: BoardInfo): MspReport => ({
  boardName: info.boardName,
  targetName: info.targetName,
  manufacturerId: info.manufacturerId,
});

export async function rebootFcToBootsel(
  board: FlasherTarget | null,
  open: () => Promise<RebootConnection> = () => MspConnection.request(),
): Promise<RebootResult> {
  if (!board) return {kind: 'error', text: 'Choose your board in step 1 first.'};
  let conn: RebootConnection | null = null;
  try {
    conn = await open();
    const info = await conn.identify();
    const problems = fcTargetProblems({chosen: board, reported: toReport(info)});
    if (problems.length) return {kind: 'error', text: `${problems.join(' ')} Not restarting it.`};
    await conn.rebootToBootloader();
    return {kind: 'ok', text: REBOOT_SENT_TEXT};
  } catch (e) {
    const text = pickerErrText(e) || 'The board did not respond.';
    return {kind: 'error', text: `${text} If the picker showed nothing, hold BOOT while plugging in USB instead.`};
  } finally {
    await conn?.close().catch(() => {});
  }
}
