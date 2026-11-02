/**
 * /guides/flash, flight controller: one "Update firmware" button (Chrome/Edge)
 * that runs the stage machine in fc-update.ts, a collapsed "Other ways" copy
 * method (any browser) and a collapsed "Details". Copy: audience-checked
 * (incutec-drafts/web-flasher/audience-result.md).
 *
 * Safety lives in fc-update.ts + gates.ts, unchanged: the board is identified
 * over serial, the file is verified against its pinned SHA-256 and target,
 * and fcDirectWriteGate (chip package + firmware on the board + hardware
 * flags or the staging switch) decides every write. With the gates off the
 * button is disabled with a one-line reason and Other ways opens.
 */

import {useEffect, useId, useRef, useState} from 'react';
import {ChoiceLadder} from '~/components/ChoiceLadder';
import {FIRMWARE_MANIFEST, releasesFor} from '../firmware-manifest.ts';
import {
  BOOT_HINT,
  continueUpdate,
  DONE_TEXT,
  STAGE_TEXT,
  startUpdate,
  type FlowDeps,
  type FlowResult,
  type Prepared,
  type Stage,
} from '../fc-update.ts';
import {fcTargetProblems, knownFcNamesIn} from '../gates.ts';
import {fetchVerifiedFirmware, isPublished, releaseFileName, type FirmwareRelease} from '../manifest.ts';
import {MspConnection} from '../msp.ts';
import {Picoboot} from '../picoboot.ts';
import {
  CHIP_PACKAGE_VERIFIED,
  FLASHER_TARGETS,
  PICOBOOT_WRITE_VERIFIED,
  RP2350_BOOTSEL_PID,
  RPI_VID,
  type FlasherTarget,
} from '../targets.ts';
import {imageContainsAscii, parseInfoUf2, parseUf2} from '../uf2.ts';
import {StatusLine, errText, saveBytes, useBeforeUnloadWhile, useStagingBench, type Status} from './status.tsx';

const short = (t: FlasherTarget) => t.displayName.replace(/ \(.*\)$/, '');

/** Download + verify the pinned file for a board: SHA-256 (fetchVerifiedFirmware), UF2 family/range, target name. */
async function prepareFor(target: FlasherTarget): Promise<Prepared> {
  const release = releasesFor(target.target).find(isPublished);
  if (!release) throw new Error(`No firmware is published for ${short(target)} yet.`);
  const {bytes, sha256} = await fetchVerifiedFirmware(release, window.location.href);
  const image = parseUf2(bytes, {familyId: target.uf2Family, flashSize: target.flashSize});
  const problems = fcTargetProblems({
    chosen: target,
    manifestTarget: release.target,
    imageNames: knownFcNamesIn((n) => imageContainsAscii(image, n)),
  });
  if (problems.length) throw new Error(problems.join(' '));
  return {target, release, image, bytes, sha256, fileName: releaseFileName(release)};
}

/** An RP2350 Boot device the browser already permits, once it shows up (up to timeoutMs). Never opens a picker. */
async function findPermittedBootsel(timeoutMs: number): Promise<unknown | null> {
  const usb = navigator.usb;
  if (!usb) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dev = (await usb.getDevices()).find((d) => d.vendorId === RPI_VID && d.productId === RP2350_BOOTSEL_PID);
    if (dev) return dev;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

type Run =
  | {kind: 'idle'}
  | {kind: 'running'; stage: Stage; percent?: number}
  | {kind: 'need-usb'}
  | {kind: 'failed'; stage: Stage; text: string}
  | {kind: 'refused'; text: string}
  | {kind: 'done'};

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
  // CONST || staging switch, read after mount (hydration-safe). The gate itself runs in fc-update.ts.
  const staging = useStagingBench();
  const writesOn = staging || (CHIP_PACKAGE_VERIFIED && PICOBOOT_WRITE_VERIFIED);
  const browserOk = hasUsb && hasSerial;
  const canRun = browserOk && writesOn;

  const [run, setRun] = useState<Run>({kind: 'idle'});
  /** What the last attempt learned, so Continue resumes at the WebUSB stage. */
  const ctx = useRef<{board: FlasherTarget | null; prepared: Prepared | null}>({board: null, prepared: null});
  const [resumeBoard, setResumeBoard] = useState<FlasherTarget | null>(null);
  const running = run.kind === 'running';
  useBeforeUnloadWhile(running && (run.stage === 'install' || run.stage === 'restart'));
  useEffect(() => onBusyChange(running), [running, onBusyChange]);

  const deps: FlowDeps = {
    gatesOn: () => canRun,
    openSerial: () => MspConnection.request(),
    prepare: prepareFor,
    findBootsel: findPermittedBootsel,
    openPicoboot: (dev) => (dev ? Picoboot.open(dev as Parameters<typeof Picoboot.open>[0]) : Picoboot.request()),
    onStage: (stage, percent) => {
      setRun({kind: 'running', stage, percent});
      if (stage !== 'install' || percent === 0) say(STAGE_TEXT[stage].replace('{n}', String(percent ?? 0)));
    },
  };

  const finish = (r: FlowResult) => {
    if (r.kind === 'done') {
      ctx.current = {board: null, prepared: null};
      setRun({kind: 'done'});
      say(DONE_TEXT);
    } else if (r.kind === 'need-usb') {
      ctx.current = {board: r.board, prepared: r.prepared};
      setRun({kind: 'need-usb'});
      say(STAGE_TEXT.usb);
    } else if (r.kind === 'failed') {
      ctx.current = {board: r.board, prepared: r.prepared};
      setResumeBoard(r.board);
      setRun({kind: 'failed', stage: r.stage, text: r.text});
      say(`${r.text} ${BOOT_HINT}`);
    } else {
      setRun({kind: 'refused', text: r.text});
      say(r.text);
    }
  };

  const start = async () => {
    if (running) return;
    ctx.current = {board: null, prepared: null};
    setResumeBoard(null);
    const r = await startUpdate(deps).catch(
      (e): FlowResult => ({kind: 'failed', stage: 'serial', text: errText(e), board: null, prepared: null}),
    );
    finish(r);
  };
  const resume = async () => {
    if (running) return;
    const board = ctx.current.board ?? resumeBoard;
    const prepared = ctx.current.prepared;
    const r = await continueUpdate(deps, {board, prepared}).catch(
      (e): FlowResult => ({kind: 'failed', stage: 'usb', text: errText(e), board, prepared}),
    );
    finish(r);
  };

  const needsBoardForResume = run.kind === 'failed' && !ctx.current.board;
  const statusLine =
    run.kind === 'running'
      ? STAGE_TEXT[run.stage].replace('{n}', String(run.percent ?? 0))
      : run.kind === 'need-usb'
        ? STAGE_TEXT.usb
        : run.kind === 'done'
          ? DONE_TEXT
          : null;

  return (
    <section className="flash-update" aria-labelledby="fc-update-title">
      <h2 id="fc-update-title" className="flash-update-title">
        Before you start
      </h2>
      <ul className="flash-checklist">
        <li>Battery unplugged, props off. USB only.</li>
        <li>
          Save your settings: Betaflight CLI, <code>diff all</code>. Flashing resets them.
        </li>
        <li>Chrome or Edge, OpenFC-Lite or Lite Mini.</li>
      </ul>

      <button type="button" className="btn-primary" onClick={() => void start()} disabled={!canRun || running}>
        Update firmware
      </button>
      {!browserOk ? (
        <p className="flash-note">This browser can&apos;t reach USB. Use Other ways.</p>
      ) : !writesOn ? (
        <p className="flash-note">Direct install is off for now. Use Other ways.</p>
      ) : null}

      <div aria-live="polite">
        {statusLine ? <p className="flash-stage">{statusLine}</p> : null}
        {run.kind === 'need-usb' ? (
          <button type="button" className="btn-secondary mt-2" onClick={() => void resume()}>
            Continue
          </button>
        ) : null}
        {run.kind === 'failed' ? (
          <div role="alert" className="flash-fail">
            <p>
              {run.text} {BOOT_HINT}
            </p>
            {needsBoardForResume ? (
              <ChoiceLadder
                className="flash-ladder mt-2"
                ariaLabel="Which board is it?"
                tabbableKey={resumeBoard?.target ?? FLASHER_TARGETS[0]?.target}
                onSelect={(key) => setResumeBoard(FLASHER_TARGETS.find((t) => t.target === key) ?? null)}
                items={FLASHER_TARGETS.map((t) => ({key: t.target, name: short(t), selected: resumeBoard?.target === t.target}))}
              />
            ) : null}
            <button
              type="button"
              className="btn-secondary mt-2"
              onClick={() => void resume()}
              disabled={needsBoardForResume && !resumeBoard}
            >
              Continue
            </button>
          </div>
        ) : null}
        {run.kind === 'refused' ? (
          <p role="alert" className="flash-fail">
            {run.text}
          </p>
        ) : null}
      </div>

      <OtherWays open={!canRun || run.kind === 'refused'} say={say} />
      <Details />
    </section>
  );
}

/** Last resort, any browser: save the verified .uf2 and copy it onto the RP2350 drive. No board check is possible here. */
function OtherWays({open, say}: {open: boolean; say: (t: string) => void}) {
  const [board, setBoard] = useState<FlasherTarget | null>(null);
  const [status, setStatus] = useState<Status>({kind: 'idle'});
  const [infoStatus, setInfoStatus] = useState<Status>({kind: 'idle'});
  const fileId = useId();
  const staging = useStagingBench();
  // F7: the staging manifest only after mount, so server and first client render agree.
  const published = (t: FlasherTarget) =>
    (staging ? releasesFor(t.target) : FIRMWARE_MANIFEST.filter((r: FirmwareRelease) => r.target === t.target)).some(isPublished);

  const save = async () => {
    if (!board) return;
    setStatus({kind: 'busy', text: 'Checking the file.'});
    try {
      const p = await prepareFor(board);
      saveBytes(p.bytes, p.fileName);
      setStatus({kind: 'ok', text: `Saved ${p.fileName}.`});
      say(`Saved ${p.fileName}.`);
    } catch (e) {
      setStatus({kind: 'error', text: errText(e)});
    }
  };
  const checkInfo = async (file: File | undefined) => {
    if (!file) return;
    const info = parseInfoUf2(await file.text());
    setInfoStatus(
      info.boardId === 'RP2350'
        ? {kind: 'ok', text: 'That drive is an RP2350 bootloader.'}
        : {kind: 'error', text: "That drive is not an RP2350. Don't copy the file onto it."},
    );
  };

  return (
    <details className="flash-more" open={open}>
      <summary>Other ways</summary>
      <ChoiceLadder
        className="flash-ladder mt-3"
        ariaLabel="Which board?"
        tabbableKey={board?.target ?? FLASHER_TARGETS[0]?.target}
        onSelect={(key) => {
          setBoard(FLASHER_TARGETS.find((t) => t.target === key) ?? null);
          setStatus({kind: 'idle'});
        }}
        items={FLASHER_TARGETS.map((t) => ({
          key: t.target,
          name: short(t),
          selected: board?.target === t.target,
          disabled: !published(t),
        }))}
      />
      <button type="button" className="btn-secondary mt-3" onClick={() => void save()} disabled={!board}>
        Save firmware (.uf2)
      </button>
      <StatusLine status={status} />
      <p className="mt-3">
        Hold BOOT while plugging in USB, then copy the file onto the RP2350 drive. The board restarts by itself. Check the
        name printed on the board first: this method can&apos;t stop a wrong file.
      </p>
      <label htmlFor={fileId} className="mt-3 block">
        Not sure about the drive? Pick INFO_UF2.TXT from it.
      </label>
      <input id={fileId} type="file" accept=".txt,text/plain" className="mt-2 block" onChange={(e) => void checkInfo(e.target.files?.[0])} />
      <StatusLine status={infoStatus} />
    </details>
  );
}

/** Version, target and SHA-256 per board: collapsed, for the people who want them. */
function Details() {
  const staging = useStagingBench();
  const rows = FLASHER_TARGETS.flatMap((t) =>
    (staging ? releasesFor(t.target) : FIRMWARE_MANIFEST.filter((r) => r.target === t.target)).filter(isPublished).map((r) => ({t, r})),
  );
  return (
    <details className="flash-more">
      <summary>Details</summary>
      {rows.length ? (
        <ul className="mt-2">
          {rows.map(({t, r}) => (
            <li key={t.target} className="mt-2">
              {short(t)}: Betaflight {r.version}, target <code>{t.target}</code>. SHA-256{' '}
              <span className="flash-filename">{r.sha256}</span>
            </li>
          ))}
          <li className="mt-2">The file is checked against its SHA-256 before install.</li>
        </ul>
      ) : (
        <p className="mt-2">No firmware is published yet.</p>
      )}
    </details>
  );
}
