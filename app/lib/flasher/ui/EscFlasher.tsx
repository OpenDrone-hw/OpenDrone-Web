/**
 * ESC (OpenESC, AM32 on AT32F421) flow on /flash.
 *
 *   - Firmware: pinned release -> same-origin download -> SHA-256 -> Intel
 *     HEX parse -> address guard (no bootloader, no EEPROM page) -> the image
 *     must carry the chosen ESC's firmware name and no other.
 *   - Read ESC info (Chromium, Web Serial): through a Betaflight FC
 *     (MSP_SET_PASSTHROUGH, then the 4-way interface) or a USB link adapter
 *     speaking 4-way directly. Read-only: bootloader signature (MCU) and the
 *     AM32 EEPROM firmware name for every ESC.
 *   - Direct write: per ESC, only when escDirectWriteGate allows it. With the
 *     shipped AM32_*_VERIFIED=false flags it never does; there is no override.
 *   - Fallback, always shown: save the verified file and flash it with
 *     esc-configurator.com.
 *   - F6 (review-fable-2.md): while a session is open the FC sits in 4-way
 *     passthrough and ignores MSP until InterfaceExit or a power cycle, so
 *     leaving the page warns (beforeunload) and pagehide sends a best-effort
 *     InterfaceExit.
 */

import {useEffect, useMemo, useRef, useState} from 'react';
import {ESC_CONFIGURATOR_URL} from '../am32-layout.ts';
import {flashAm32, identifyEsc, prepareAm32Image, type Am32Image, type Am32Phase, type EscIdentity} from '../am32.ts';
import {releasesFor} from '../firmware-manifest.ts';
import {FourWay} from '../fourway.ts';
import {escDirectWriteGate, escTargetProblems} from '../gates.ts';
import {fetchVerifiedFirmware, isPublished, releaseFileName, type FirmwareRelease} from '../manifest.ts';
import {MspConnection} from '../msp.ts';
import {SerialLink} from '../serial-link.ts';
import {ESC_TARGETS, type EscTarget} from '../targets.ts';
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

type Verified = {target: EscTarget; release: FirmwareRelease; bytes: Uint8Array; image: Am32Image; fileName: string};

type Session = {link: SerialLink; fw: FourWay; via: 'fc' | 'adapter'; escs: EscIdentity[]};

/** Link adapters running 4way-if firmware; FC passthrough ignores the rate (USB CDC). */
const SERIAL_BAUD = 115200;

const PHASE_TEXT: Record<Am32Phase, string> = {
  identify: 'Checking the ESC again.',
  backup: 'Reading the ESC settings page.',
  'erase-first': 'Clearing the firmware start so a half-finished update cannot run.',
  write: 'Writing and checking firmware.',
  'write-first': 'Writing the firmware start last.',
  'check-eeprom': 'Checking the ESC settings are unchanged.',
  reset: 'Restarting the ESC.',
};

export function EscFlasher({
  hasSerial,
  say,
  onBusyChange,
}: {
  hasSerial: boolean;
  say: (t: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [esc, setEsc] = useState<EscTarget | null>(null);
  const [verified, setVerified] = useState<Verified | null>(null);
  const [fwStatus, setFwStatus] = useState<Status>({kind: 'idle'});
  const [via, setVia] = useState<'fc' | 'adapter'>('fc');
  const [session, setSession] = useState<Session | null>(null);
  const [connStatus, setConnStatus] = useState<Status>({kind: 'idle'});
  const [writing, setWriting] = useState<number | null>(null);
  const [progress, setProgress] = useState<{done: number; total: number} | null>(null);
  const prepareSeq = useRef(0);

  const [connecting, setConnecting] = useState(false);
  const releases = useMemo(() => (esc ? releasesFor(esc.target) : []), [esc]);
  const busy = !!session || connecting || writing !== null;
  // F6: an open session means the FC is in passthrough; warn before the tab closes or navigates away.
  useBeforeUnloadWhile(busy);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  // Leave passthrough and release the port if the panel goes away.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  // F6: best effort on tab close / navigation (the unmount cleanup below does not run in time then).
  useEffect(() => {
    const onHide = () => {
      const s = sessionRef.current;
      if (s?.via === 'fc') void s.fw.exit().catch(() => {});
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);
  useEffect(
    () => () => {
      const s = sessionRef.current;
      if (s) void (s.via === 'fc' ? s.fw.exit().catch(() => {}) : Promise.resolve()).then(() => s.link.close());
      onBusyChange(false);
    },
    [onBusyChange],
  );

  const chooseEsc = (t: EscTarget) => {
    if (busy) return;
    prepareSeq.current++;
    setEsc(t);
    setVerified(null);
    setFwStatus({kind: 'idle'});
    say(`${t.displayName} selected.`);
  };

  const prepare = async (release: FirmwareRelease) => {
    if (!esc || busy) return;
    const seq = ++prepareSeq.current;
    const target = esc;
    setVerified(null);
    setFwStatus({kind: 'busy', text: 'Downloading and checking the firmware.'});
    try {
      const problems = escTargetProblems({chosen: target, manifestTarget: release.target});
      if (problems.length) throw new Error(problems.join(' '));
      const {bytes} = await fetchVerifiedFirmware(release, window.location.href);
      const image = prepareAm32Image(new TextDecoder().decode(bytes), target);
      if (seq !== prepareSeq.current) return;
      setVerified({target, release, bytes, image, fileName: releaseFileName(release)});
      const msg = `Firmware verified: SHA-256 matches the pinned release, AM32 image for ${target.target}, bootloader and settings areas untouched.`;
      setFwStatus({kind: 'ok', text: msg});
      say(msg);
    } catch (e) {
      if (seq !== prepareSeq.current) return;
      setFwStatus({kind: 'error', text: errText(e)});
    }
  };

  const disconnect = async (s: Session | null = session) => {
    if (!s) return;
    if (s.via === 'fc') await s.fw.exit().catch(() => {});
    await s.link.close().catch(() => {});
    setSession(null);
  };

  const readEscsInner = async () => {
    setConnStatus({kind: 'busy', text: 'Connecting.'});
    let link: SerialLink;
    try {
      link = await SerialLink.request(SERIAL_BAUD);
    } catch (e) {
      setConnStatus({kind: 'error', text: pickerErrText(e)});
      return;
    }
    const fw = new FourWay(link);
    const s: Session = {link, fw, via, escs: []};
    try {
      let count = 1;
      if (via === 'fc') {
        const msp = new MspConnection(link);
        const info = await msp.identify();
        if (info.fcVariant !== 'BTFL') throw new Error(`The flight controller runs ${info.fcVariant}, not Betaflight.`);
        setConnStatus({kind: 'busy', text: 'Switching the flight controller to ESC passthrough.'});
        count = await msp.enterEscPassthrough();
        // MSP_SET_PASSTHROUGH answers with the number of motor outputs Betaflight has configured (battery and protocol do not matter).
        if (count < 1) throw new Error('Betaflight has no motor outputs configured, so there are no ESCs to read. Check the motor/mixer setup in the Betaflight app.');
      } else {
        await fw.testAlive();
      }
      for (let i = 0; i < count; i++) {
        setConnStatus({kind: 'busy', text: `Reading ESC ${i + 1} of ${count}.`});
        s.escs.push(await identifyEsc(fw, i));
      }
      setSession({...s});
      const none = s.escs.every((id) => id.mcu.status === 'unreadable');
      const msg = none
        ? `No ESC answered on ${count} motor output${count === 1 ? '' : 's'}. Is the flight battery plugged in? The ESCs are powered only by the battery. Click Disconnect, plug the battery in (props off) and read again.`
        : `Read ${count} motor output${count === 1 ? '' : 's'}. When you are done, click Disconnect, then unplug the battery.`;
      setConnStatus({kind: none ? 'error' : 'ok', text: msg});
      say(msg);
    } catch (e) {
      await disconnect(s);
      setConnStatus({kind: 'error', text: errText(e)});
    }
  };

  const readEscs = async () => {
    if (busy) return;
    setConnecting(true);
    try {
      await readEscsInner();
    } finally {
      setConnecting(false);
    }
  };

  const write = async (index: number) => {
    if (!session || !esc || !verified || writing !== null) return;
    setWriting(index);
    setConnStatus({kind: 'busy', text: `Installing on ESC ${index + 1}. Do not unplug anything.`});
    try {
      await flashAm32(session.fw, index, verified.image, esc, verified.release, (phase, done, total) => {
        setProgress({done, total});
        say(`${PHASE_TEXT[phase]} ${Math.round((done / Math.max(total, 1)) * 100)} percent.`);
      });
      setConnStatus({kind: 'ok', text: `Installed ${verified.release.version} on ESC ${index + 1}.`});
    } catch (e) {
      setConnStatus({
        kind: 'error',
        text: `${errText(e)} The AM32 bootloader is not touched by this page, so the ESC can be flashed again: retry, or use esc-configurator with the verified file.`,
      });
    } finally {
      setWriting(null);
    }
  };

  const verifiedForEsc = verified && esc && verified.target.target === esc.target ? verified : null;

  return (
    <>
      <Step id="esc" n={1} title="Choose your ESC" open>
        <fieldset disabled={busy}>
          <legend className="text-[15px] text-[var(--color-text-muted)]">The name is printed on the board.</legend>
          {ESC_TARGETS.map((t) => (
            <label key={t.target} className="mt-2 flex items-center gap-2 text-[16px]">
              <input type="radio" name="esc-board" checked={esc?.target === t.target} onChange={() => chooseEsc(t)} />
              {t.displayName} <span className="font-mono text-[13px] text-[var(--color-text-muted)]">{t.target}</span>
            </label>
          ))}
        </fieldset>
        <p className="mt-2 text-[15px] text-[var(--color-text-muted)]">OpenESC-30x30 firmware is not listed here yet.</p>
      </Step>

      <Step id="esc" n={2} title="Get the firmware" open={!!esc}>
        {esc && !releases.length ? <p className="text-[15px]">No firmware is listed for this ESC.</p> : null}
        {releases.map((r) => (
          <div key={r.version} className="mt-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[15px]">
              <dt className="text-[var(--color-text-muted)]">Firmware</dt>
              <dd>{r.firmware}</dd>
              <dt className="text-[var(--color-text-muted)]">Target</dt>
              <dd className="font-mono">{r.target}</dd>
              {isPublished(r) ? (
                <>
                  <dt className="text-[var(--color-text-muted)]">Version</dt>
                  <dd>
                    {r.version} ({r.channel}){' '}
                    {r.channel !== 'stable' ? <strong>Pre-release ({r.channel}) build, not a stable release.</strong> : null}
                  </dd>
                  <dt className="text-[var(--color-text-muted)]">SHA-256</dt>
                  <dd className="font-mono text-[13px] break-all">{r.sha256}</dd>
                </>
              ) : null}
            </dl>
            {isPublished(r) ? (
              <button type="button" className="btn-primary btn-sm mt-3" onClick={() => void prepare(r)} disabled={busy}>
                Download and verify {r.version}
              </button>
            ) : (
              <p className="mt-3 text-[15px]">
                <strong>Firmware not published yet.</strong> This page cannot offer it until the release file is
                published.
              </p>
            )}
          </div>
        ))}
        <StatusLine status={fwStatus} />
      </Step>

      <Step id="esc" n={3} title="Install with esc-configurator" open={!!verifiedForEsc}>
        {verifiedForEsc ? (
          <ol className="list-decimal pl-6 text-[16px]">
            <li>Take the propellers off. The ESC needs the flight battery connected to talk to the computer.</li>
            <li>
              <button type="button" className="btn-primary btn-sm" onClick={() => saveBytes(verifiedForEsc.bytes, verifiedForEsc.fileName)}>
                Save {verifiedForEsc.fileName}
              </button>
            </li>
            <li>
              Open{' '}
              <a href={ESC_CONFIGURATOR_URL} target="_blank" rel="noopener noreferrer" className="underline">
                esc-configurator.com
              </a>
              , connect, read the ESCs, and use <em>Flash all</em> with <em>Select file</em> pointing at the saved file.
            </li>
          </ol>
        ) : null}
      </Step>

      {hasSerial ? (
        <Step id="esc" n={4} title="Check your ESCs (optional, Chrome or Edge)" open={!!esc}>
          {esc ? (
            <>
              <p className="text-[15px]">
                Reads which chip and firmware name each ESC has, without changing anything. It does not show the AM32
                version or the ESC settings; use esc-configurator for those. Propellers off, then plug the flight
                battery in <em>before</em> you click Read: one click connects, switches the flight controller to ESC
                passthrough and reads every motor output. The flight controller does not have to be an OpenFC.
              </p>
              <p className="mt-2 text-[15px]">
                When you are done, click <strong>Disconnect</strong>, then unplug the battery. If you close the tab
                without disconnecting, the flight controller stays in passthrough and the Betaflight app cannot connect
                until you unplug USB and the battery and plug them back in.
              </p>
              <fieldset className="mt-3" disabled={busy}>
                <legend className="text-[15px]">Connected through</legend>
                <label className="mt-1 flex items-center gap-2 text-[15px]">
                  <input type="radio" name="esc-via" checked={via === 'fc'} onChange={() => setVia('fc')} />
                  the flight controller (Betaflight, USB)
                </label>
                <label className="mt-1 flex items-center gap-2 text-[15px]">
                  <input type="radio" name="esc-via" checked={via === 'adapter'} onChange={() => setVia('adapter')} />
                  a USB link adapter on the ESC signal pad
                </label>
              </fieldset>
              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-secondary btn-sm" onClick={() => void readEscs()} disabled={busy}>
                  Read ESC info
                </button>
                {session ? (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void disconnect()} disabled={writing !== null}>
                    Disconnect
                  </button>
                ) : null}
              </div>
              {session ? (
                <ul className="mt-3 text-[15px]">
                  {session.escs.map((id) => (
                    <EscRow
                      key={id.index}
                      id={id}
                      esc={esc}
                      verified={verifiedForEsc}
                      writing={writing}
                      onWrite={() => void write(id.index)}
                    />
                  ))}
                </ul>
              ) : null}
              {progress && writing !== null ? (
                <progress className="mt-3 w-full" max={progress.total} value={progress.done} aria-label="ESC install progress" />
              ) : null}
              <StatusLine status={connStatus} />
            </>
          ) : null}
        </Step>
      ) : null}
    </>
  );
}

function EscRow({
  id,
  esc,
  verified,
  writing,
  onWrite,
}: {
  id: EscIdentity;
  esc: EscTarget;
  verified: Verified | null;
  writing: number | null;
  onWrite: () => void;
}) {
  const show = (r: EscIdentity['mcu'] | EscIdentity['firmwareName']) => (r.status === 'ok' ? r.value : `${r.status} (${r.detail})`);
  const problems = escTargetProblems({chosen: esc, escMcu: id.mcu, escFirmwareName: id.firmwareName});
  const gate = verified
    ? escDirectWriteGate({
        chosen: esc,
        release: verified.release,
        verifiedFor: verified.target.target,
        mcu: id.mcu,
        firmwareName: id.firmwareName,
      })
    : {allowed: false, reasons: ['No verified firmware file yet.']};
  return (
    <li className="mt-3">
      <strong>ESC {id.index + 1}:</strong> chip {show(id.mcu)}, firmware {show(id.firmwareName)}{' '}
      <strong>{problems.length ? 'MISMATCH' : 'Match'}</strong>
      <BlockedReasons title="Direct install not available. Use esc-configurator with the verified file:" reasons={gate.reasons} />
      {gate.allowed ? (
        <button type="button" className="btn-primary btn-sm mt-2" onClick={onWrite} disabled={writing !== null}>
          Install on ESC {id.index + 1}
        </button>
      ) : null}
    </li>
  );
}
