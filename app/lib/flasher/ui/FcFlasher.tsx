/**
 * Flight controller (OpenFC-Lite / Lite Mini, RP2354) flow on /flash.
 *
 *   - Copy method (every browser, the default): pinned release -> same-origin
 *     download -> SHA-256 (crypto.subtle) -> UF2 family/range parse -> the
 *     image must name the chosen target and no other -> the user saves it and
 *     drags it onto the RP2350 drive.
 *   - Direct install (Chromium, WebUSB PICOBOOT): only when fcDirectWriteGate
 *     allows it. With CHIP_PACKAGE_VERIFIED / PICOBOOT_WRITE_VERIFIED false
 *     (shipped) the panel only explains that it is off; no override.
 *   - MSP over Web Serial identifies a running board and restarts it into
 *     BOOTSEL; a report for another board is a hard stop.
 *
 * R1 (review-flash-write-safety.md): the verified image carries its target,
 * stale downloads are dropped by a sequence counter, and the board choice is
 * locked while a device is open or writing.
 * F3 (review-fable-2.md): DirectInstall keeps {device, chip, installed} as one
 * object set once after a complete read, clears it before the picker opens,
 * and disables Install while connecting. F12: after a successful Identify the
 * board choice is locked to the identified board until Identify runs again.
 */

import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {releasesFor} from '../firmware-manifest.ts';
import {FC_GATES, fcDirectWriteGate, fcInstallEnabled, fcTargetProblems, knownFcNamesIn, type MspReport} from '../gates.ts';
import {fetchVerifiedFirmware, isPublished, releaseFileName, type FirmwareRelease} from '../manifest.ts';
import {MspConnection, type BoardInfo} from '../msp.ts';
import {Picoboot, chipPackageResult, type ChipInfo, type FlashPhase} from '../picoboot.ts';
import {FLASHER_TARGETS, type FlasherTarget} from '../targets.ts';
import {imageContainsAscii, parseInfoUf2, parseUf2, type Uf2Image} from '../uf2.ts';
import {
  BlockedReasons,
  StatusLine,
  Step,
  errText,
  pickerErrText,
  saveBytes,
  useBeforeUnloadWhile,
  type Status,
} from './status.tsx';

type Verified = {
  /** The board this image was verified FOR. Every later check compares against it (R1). */
  target: FlasherTarget;
  release: FirmwareRelease;
  bytes: Uint8Array;
  sha256: string;
  image: Uf2Image;
  fileName: string;
};

const DIRECT_INSTALL_ENABLED = FC_GATES.CHIP_PACKAGE_VERIFIED && FC_GATES.PICOBOOT_WRITE_VERIFIED;

export function FcFlasher({
  hasUsb,
  hasSerial,
  say,
  onBusyChange,
}: {
  hasUsb: boolean;
  hasSerial: boolean;
  say: (t: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [board, setBoard] = useState<FlasherTarget | null>(null);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [fwStatus, setFwStatus] = useState<Status>({kind: 'idle'});
  const [fcInfo, setFcInfo] = useState<BoardInfo | null>(null);
  const [fcStatus, setFcStatus] = useState<Status>({kind: 'idle'});
  const [rebootStatus, setRebootStatus] = useState<Status>({kind: 'idle'});
  const [infoUf2Status, setInfoUf2Status] = useState<Status>({kind: 'idle'});
  /** F12: board reported by the last successful Identify. The other radios stay disabled until Identify runs again. */
  const [lockedTo, setLockedTo] = useState<FlasherTarget | null>(null);
  /** Bumped on every board change or new download, so a slow download cannot land under another board (R1). */
  const prepareSeq = useRef(0);
  /** True while the direct-install panel holds the board open or is writing: the board choice is locked (R1). */
  const [deviceBusy, setDeviceBusy] = useState(false);

  const releases = useMemo(() => (board ? releasesFor(board.target) : []), [board]);
  useEffect(() => onBusyChange(deviceBusy), [deviceBusy, onBusyChange]);

  const chooseBoard = (t: FlasherTarget, fromIdentify = false) => {
    if (deviceBusy) return;
    if (!fromIdentify && lockedTo && lockedTo.target !== t.target) return;
    prepareSeq.current++;
    setBoard(t);
    setVerified(null);
    setFwStatus({kind: 'idle'});
    say(`${t.displayName} selected.`);
  };

  const prepare = async (release: FirmwareRelease) => {
    if (!board || deviceBusy) return;
    const seq = ++prepareSeq.current;
    const target = board;
    setVerified(null);
    setFwStatus({kind: 'busy', text: 'Downloading and checking the firmware.'});
    say('Downloading and checking the firmware.');
    try {
      const {bytes, sha256} = await fetchVerifiedFirmware(release, window.location.href);
      const image = parseUf2(bytes, {familyId: target.uf2Family, flashSize: target.flashSize});
      const problems = fcTargetProblems({
        chosen: target,
        manifestTarget: release.target,
        imageNames: knownFcNamesIn((n) => imageContainsAscii(image, n)),
      });
      if (problems.length) throw new Error(problems.join(' '));
      if (seq !== prepareSeq.current) return; // board changed meanwhile: drop this result
      setVerified({target, release, bytes, sha256, image, fileName: releaseFileName(release)});
      const msg = `Firmware verified: SHA-256 matches the pinned release, UF2 for RP2350, built for ${target.target}.`;
      setFwStatus({kind: 'ok', text: msg});
      say(msg);
    } catch (e) {
      if (seq !== prepareSeq.current) return;
      setFwStatus({kind: 'error', text: errText(e)});
    }
  };

  const toReport = (info: BoardInfo): MspReport => ({
    boardName: info.boardName,
    targetName: info.targetName,
    manufacturerId: info.manufacturerId,
  });

  const identify = async () => {
    setLockedTo(null);
    setFcStatus({kind: 'busy', text: 'Asking the flight controller who it is.'});
    let conn: MspConnection | null = null;
    try {
      conn = await MspConnection.request();
      const info = await conn.identify();
      setFcInfo(info);
      const known = FLASHER_TARGETS.find((t) => fcTargetProblems({chosen: t, reported: toReport(info)}).length === 0);
      if (!known) {
        setFcStatus({kind: 'error', text: `This is ${info.manufacturerId} ${info.boardName || info.targetName}, not a board this page can update.`});
      } else {
        const lock = `The board choice is now locked to ${known.displayName}; run Identify again to change it.`;
        const wrong = board && known.target !== board.target ? board : null;
        setLockedTo(known);
        if (board?.target !== known.target) chooseBoard(known, true);
        const msg = wrong
          ? `This board reports ${known.displayName}, but you had chosen ${wrong.displayName}. Switched to ${known.displayName}. Check the name printed on the board. ${lock}`
          : `Found ${known.displayName} running ${info.fcVariant} ${info.fcVersion}. ${lock}`;
        setFcStatus({kind: wrong ? 'error' : 'ok', text: msg});
        say(msg);
      }
    } catch (e) {
      setFcStatus({kind: 'error', text: pickerErrText(e)});
    } finally {
      await conn?.close();
    }
  };

  const rebootToBootsel = async () => {
    if (!board) return;
    setRebootStatus({kind: 'busy', text: 'Restarting the board into bootloader mode.'});
    let conn: MspConnection | null = null;
    try {
      conn = await MspConnection.request();
      const info = await conn.identify();
      const problems = fcTargetProblems({chosen: board, reported: toReport(info)});
      if (problems.length) throw new Error(`${problems.join(' ')} Not restarting it.`);
      await conn.rebootToBootloader();
      const msg = 'Restart command sent. If a drive named RP2350 appears, the board is in bootloader mode. If the board just restarts into Betaflight, use the BOOT button instead.';
      setRebootStatus({kind: 'ok', text: msg});
      say(msg);
    } catch (e) {
      setRebootStatus({kind: 'error', text: pickerErrText(e)});
    } finally {
      await conn?.close().catch(() => {});
    }
  };

  const download = () => {
    if (!verified || !board || verified.target.target !== board.target) return;
    saveBytes(verified.bytes, verified.fileName);
    say(`Saved ${verified.fileName}. Now copy it onto the RP2350 drive.`);
  };

  const checkInfoUf2 = async (file: File | undefined) => {
    if (!file) return;
    const info = parseInfoUf2(await file.text());
    if (info.boardId === 'RP2350') {
      setInfoUf2Status({kind: 'ok', text: `That drive is an RP2350 bootloader (${info.model ?? 'model not stated'}). The drive alone cannot tell OpenFC-Lite and OpenFC-Lite Mini apart: check the board name printed on the board.`});
    } else {
      setInfoUf2Status({kind: 'error', text: `That drive reports Board-ID "${info.boardId ?? 'none'}", not RP2350. Do not copy the file onto it.`});
    }
  };

  const verifiedForBoard = verified && board && verified.target.target === board.target ? verified : null;

  return (
    <>
      <Step id="fc" n={1} title="Choose your board" open>
        <fieldset disabled={deviceBusy}>
          <legend className="text-[15px] text-[var(--color-text-muted)]">The name is printed on the board.</legend>
          {FLASHER_TARGETS.map((t) => (
            <label key={t.target} className="mt-2 flex items-center gap-2 text-[16px]">
              <input
                type="radio"
                name="fc-board"
                checked={board?.target === t.target}
                disabled={!!lockedTo && lockedTo.target !== t.target}
                onChange={() => chooseBoard(t)}
              />
              {t.displayName} <span className="font-mono text-[13px] text-[var(--color-text-muted)]">{t.target}</span>
            </label>
          ))}
        </fieldset>
        {hasSerial ? (
          <div className="mt-4">
            <p className="text-[15px]">Board running Betaflight and plugged in? Let the page read its name instead.</p>
            <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => void identify()} disabled={deviceBusy}>
              Identify connected board
            </button>
            {fcInfo ? (
              <p className="mt-2 font-mono text-[13px]">
                {fcInfo.manufacturerId} {fcInfo.boardName} ({fcInfo.fcVariant} {fcInfo.fcVersion}, MSP {fcInfo.apiVersion})
              </p>
            ) : null}
            <StatusLine status={fcStatus} />
          </div>
        ) : null}
      </Step>

      <Step id="fc" n={2} title="Get the firmware" open={!!board}>
        {board && !releases.length ? <p className="text-[15px]">No firmware is listed for this board.</p> : null}
        {board
          ? releases.map((r) => (
              <div key={r.version} className="mt-2">
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[15px]">
                  <dt className="text-[var(--color-text-muted)]">Version</dt>
                  <dd>
                    {r.version} ({r.channel}){' '}
                    {r.channel !== 'stable' ? <strong>Pre-release ({r.channel}) Betaflight build, not a stable release.</strong> : null}
                  </dd>
                  <dt className="text-[var(--color-text-muted)]">Firmware</dt>
                  <dd>{r.firmware}</dd>
                  <dt className="text-[var(--color-text-muted)]">Target</dt>
                  <dd className="font-mono">{r.target}</dd>
                  {isPublished(r) ? (
                    <>
                      <dt className="text-[var(--color-text-muted)]">SHA-256</dt>
                      <dd className="font-mono text-[13px] break-all">{r.sha256}</dd>
                    </>
                  ) : null}
                </dl>
                {isPublished(r) ? (
                  <button type="button" className="btn-primary btn-sm mt-3" onClick={() => void prepare(r)} disabled={deviceBusy}>
                    Download and verify {r.version}
                  </button>
                ) : (
                  <p className="mt-3 text-[15px]">
                    <strong>Firmware not published yet.</strong> This page cannot offer it until the release file is
                    published.
                  </p>
                )}
              </div>
            ))
          : null}
        <StatusLine status={fwStatus} />
      </Step>

      <Step id="fc" n={3} title="Put the board in bootloader mode" open={!!verifiedForBoard}>
        <ol className="list-decimal pl-6 text-[16px]">
          <li>Unplug the flight battery. Keep only USB connected.</li>
          <li>
            Save your settings first: in the Betaflight app, CLI tab, run <code>diff all</code> and save the output.
          </li>
          <li>
            Then hold the BOOT button while plugging in USB. Running <code>bl rom</code> in the CLI or the button below
            should do the same, but that is not yet checked on these boards: if no RP2350 drive appears, use the BOOT
            button.
          </li>
        </ol>
        {hasSerial ? (
          <>
            <button type="button" className="btn-secondary btn-sm mt-3" onClick={() => void rebootToBootsel()} disabled={deviceBusy}>
              Restart board into bootloader
            </button>
            <StatusLine status={rebootStatus} />
          </>
        ) : null}
        <p className="mt-3 text-[15px]">
          In bootloader mode the board appears as a USB drive named <strong>RP2350</strong>.
        </p>
      </Step>

      <Step id="fc" n={4} title="Install" open={!!verifiedForBoard && !!board}>
        {verifiedForBoard && board ? (
          <>
            <h3 className="text-[17px] font-semibold">Copy the file (any browser)</h3>
            <ol className="mt-2 list-decimal pl-6 text-[16px]">
              <li>
                <button type="button" className="btn-primary btn-sm" onClick={download}>
                  Save {verifiedForBoard.fileName}
                </button>
              </li>
              <li>Copy the saved file onto the RP2350 drive. The board restarts on its own when the copy finishes.</li>
              <li>Reconnect in the Betaflight app and check your settings.</li>
            </ol>
            <InfoUf2Check onFile={checkInfoUf2} status={infoUf2Status} />
            {hasUsb ? (
              DIRECT_INSTALL_ENABLED ? (
                <DirectInstall target={board} verified={verifiedForBoard} say={say} onBusyChange={setDeviceBusy} />
              ) : (
                <p className="mt-6 text-[15px]">
                  <strong>Direct install from the browser is switched off</strong> until it has been checked on real
                  boards. The copy method above is the supported way to install.
                </p>
              )
            ) : null}
          </>
        ) : null}
      </Step>
    </>
  );
}

function InfoUf2Check({onFile, status}: {onFile: (f: File | undefined) => Promise<void>; status: Status}) {
  const id = useId();
  return (
    <div className="mt-4">
      <label htmlFor={id} className="text-[15px]">
        Not sure the drive is the board? Pick <code>INFO_UF2.TXT</code> from the drive to check it:
      </label>
      <input id={id} type="file" accept=".txt,text/plain" className="mt-2 block text-[15px]" onChange={(e) => void onFile(e.target.files?.[0])} />
      <StatusLine status={status} />
    </div>
  );
}

type Connection = {pb: Picoboot; chip: ChipInfo; installed: string[]};

const PHASE_TEXT: Record<FlashPhase, string> = {
  'erase-boot': 'Clearing the old firmware start so a half-finished update can never boot.',
  write: 'Writing and checking firmware.',
  'write-boot': 'Writing the firmware start last.',
  reboot: 'Restarting the board.',
};

/** Rendered only when both FC hardware flags are true. Every write is decided by fcDirectWriteGate. */
function DirectInstall({
  target,
  verified,
  say,
  onBusyChange,
}: {
  target: FlasherTarget;
  verified: Verified;
  say: (t: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  /** F3: device, chip and on-board scan are one object, set once after a complete read. Never a mix of two boards. */
  const [conn, setConn] = useState<Connection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<Status>({kind: 'idle'});
  const [battery, setBattery] = useState(false);
  const [progress, setProgress] = useState<{done: number; total: number} | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [finished, setFinished] = useState(false);
  const batteryId = useId();
  /** The device currently open (also while connecting), so it is closed on unmount or reconnect. */
  const openDev = useRef<Picoboot | null>(null);

  useBeforeUnloadWhile(flashing);
  useEffect(() => () => void openDev.current?.close(), []);
  useEffect(() => onBusyChange(!!conn || connecting || flashing), [conn, connecting, flashing, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  // The connection belongs to one verified image and one board choice.
  useEffect(() => {
    void openDev.current?.close().catch(() => {});
    openDev.current = null;
    setConn(null);
    setBattery(false);
    setFinished(false);
  }, [verified, target]);

  const gateFor = (c: Connection | null) =>
    fcDirectWriteGate({
      chosen: target,
      release: verified.release,
      verifiedFor: verified.target.target,
      imageStart: verified.image.start,
      imageEnd: verified.image.end,
      chipPackage: c ? chipPackageResult(c.chip) : null,
      flashBytes: c?.chip.flashBytes ?? null,
      installed: c?.installed ?? null,
    });
  const gate = gateFor(conn);
  const canFlash = fcInstallEnabled({gate, connected: !!conn, connecting, battery, flashing, finished});

  const connect = async () => {
    if (connecting || flashing) return;
    // F3: forget the previous board BEFORE the picker opens, so nothing of board A survives while board B is read.
    setConnecting(true);
    setConn(null);
    setBattery(false);
    setFinished(false);
    setStatus({kind: 'busy', text: 'Connecting to the bootloader.'});
    try {
      await openDev.current?.close().catch(() => {});
      openDev.current = null;
      let dev: Picoboot;
      try {
        dev = await Picoboot.request();
      } catch (e) {
        setStatus({kind: 'error', text: pickerErrText(e)});
        return;
      }
      openDev.current = dev;
      const chip = await dev.chipInfo();
      setStatus({kind: 'busy', text: 'Reading the firmware that is on the board now.'});
      let installed: string[];
      await dev.exclusive(true);
      try {
        await dev.exitXip();
        installed = await dev.findInstalledTargets(verified.image.start, verified.image.end);
      } finally {
        await dev.exclusive(false).catch(() => {});
      }
      setConn({pb: dev, chip, installed});
      const msg = `Connected. Chip package ${chip.chipPackage ?? 'unreadable'}; firmware on board names ${installed.length ? installed.join(', ') : 'no known OpenFC'} (scanned the range the new image covers).`;
      setStatus({kind: 'ok', text: msg});
      say(msg);
    } catch (e) {
      await openDev.current?.close().catch(() => {});
      openDev.current = null;
      setStatus({kind: 'error', text: errText(e)});
    } finally {
      setConnecting(false);
    }
  };

  const flash = async () => {
    const c = conn;
    if (!c || !canFlash) return;
    // Fresh gate on the stored connection object, not the render-time closure.
    const fresh = gateFor(c);
    if (!fresh.allowed || c.pb !== openDev.current) {
      setStatus({kind: 'error', text: `Not installing: ${fresh.reasons.join(' ') || 'the connection changed. Connect again.'}`});
      return;
    }
    setFlashing(true);
    setStatus({kind: 'busy', text: 'Installing. Do not unplug the board.'});
    say('Installing. Do not unplug the board.');
    try {
      await c.pb.flashImage(verified.image, (phase, done, total) => {
        setProgress({done, total});
        say(`${PHASE_TEXT[phase]} ${Math.round((done / total) * 100)} percent.`);
      });
      setFinished(true);
      const msg = `Installed ${verified.release.version} on ${target.displayName}. The board is restarting; reconnect in the Betaflight app and check your settings.`;
      setStatus({kind: 'ok', text: msg});
      say(msg);
    } catch (e) {
      setStatus({
        kind: 'error',
        text: `${errText(e)} The board did not get a complete image, so it will stay in bootloader mode. Nothing is damaged: reconnect and try again, or use the copy method above.`,
      });
    } finally {
      setFlashing(false);
      await c.pb.close();
      if (openDev.current === c.pb) openDev.current = null;
      setConn(null);
    }
  };

  return (
    <div className="mt-8">
      <h3 className="text-[17px] font-semibold">Or install directly (Chrome, Edge)</h3>
      <button type="button" className="btn-secondary btn-sm mt-2" onClick={() => void connect()} disabled={flashing || connecting}>
        Connect to board in bootloader mode
      </button>
      {conn ? (
        <ul className="mt-3 text-[15px]">
          <li>
            Chip package: {conn.chip.chipPackage ?? 'unreadable'} (expected {target.chipPackage}){' '}
            <strong>{conn.chip.chipPackage === target.chipPackage ? 'Match' : 'MISMATCH'}</strong>
          </li>
          <li>
            Firmware on board:{' '}
            {conn.installed.length ? conn.installed.join(', ') : 'does not name an OpenFC (blank, damaged or third-party)'}
          </li>
        </ul>
      ) : null}
      {conn ? <BlockedReasons title="Direct install not available. Use the copy method above:" reasons={gate.reasons} /> : null}
      {conn && gate.allowed ? (
        <fieldset className="mt-4" disabled={flashing || finished}>
          <legend className="text-[15px] font-semibold">Before installing</legend>
          <div className="mt-2 flex items-start gap-2">
            <input id={batteryId} type="checkbox" checked={battery} onChange={(e) => setBattery(e.target.checked)} />
            <label htmlFor={batteryId}>The flight battery is unplugged and the propellers are off.</label>
          </div>
        </fieldset>
      ) : null}
      <button type="button" className="btn-primary btn-sm mt-4" onClick={() => void flash()} disabled={!canFlash}>
        Install {verified.release.version} on {target.displayName}
      </button>
      {progress ? (
        <div className="mt-3">
          <progress className="w-full" max={progress.total} value={progress.done} aria-label="Install progress" />
          <p className="text-[14px]">
            {progress.done} of {progress.total} blocks
          </p>
        </div>
      ) : null}
      <StatusLine status={status} />
    </div>
  );
}
