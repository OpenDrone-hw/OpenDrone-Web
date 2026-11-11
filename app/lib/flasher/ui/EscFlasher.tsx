/**
 * ESC (OpenESC, AM32 on AT32F421) flow on /flash.
 *
 *   - Firmware: pinned release -> download -> SHA-256 -> Intel HEX (or, on a
 *     staging bench build, raw .bin) parse -> address guard (no bootloader, no
 *     app write into the EEPROM page) -> the image must carry the chosen ESC's
 *     firmware name and no other. A direct install also writes the pinned
 *     EEPROM v4 defaults (ESC settings are reset).
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
import {
  Am32FinalVerifyError,
  flashAm32,
  identifyEsc,
  prepareAm32Image,
  type Am32Image,
  type Am32Phase,
  type EscIdentity,
} from '../am32.ts';
import {ChoiceLadder} from '~/components/ChoiceLadder';
import {FIRMWARE_MANIFEST, releasesFor} from '../firmware-manifest.ts';
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
  useStagingBench,
  type Status,
} from './status.tsx';

type Verified = {target: EscTarget; release: FirmwareRelease; bytes: Uint8Array; image: Am32Image; fileName: string};

type Session = {link: SerialLink; fw: FourWay; via: 'fc' | 'adapter'; escs: EscIdentity[]};

/** Link adapters running 4way-if firmware; FC passthrough ignores the rate (USB CDC). */
const SERIAL_BAUD = 115200;

const PHASE_TEXT: Record<Am32Phase, string> = {
  identify: 'Checking the ESC again.',
  'erase-first': 'Clearing the firmware start so a half-finished update cannot run.',
  write: 'Writing and checking firmware.',
  'write-first': 'Writing the firmware start last.',
  'write-eeprom': 'Resetting the ESC settings to the pinned defaults and checking them.',
  'check-eeprom': 'Reading back the whole firmware and the settings.',
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
  const staging = useStagingBench();
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
      const {bytes, eeprom} = await fetchVerifiedFirmware(release, window.location.href);
      const image = prepareAm32Image(release.kind === 'am32-bin' ? bytes : new TextDecoder().decode(bytes), target, eeprom);
      if (seq !== prepareSeq.current) return;
      setVerified({target, release, bytes, image, fileName: releaseFileName(release)});
      const msg = `Firmware verified: SHA-256 matches the pinned release, AM32 image ${target.firmwareName} for ${target.displayName}, bootloader untouched.${image.eeprom ? ' Installing also resets the ESC settings to the pinned defaults.' : ''}`;
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
      const report = await flashAm32(session.fw, index, verified.image, esc, verified.release, (phase, done, total) => {
        setProgress({done, total});
        say(`${PHASE_TEXT[phase]} ${Math.round((done / Math.max(total, 1)) * 100)} percent.`);
      });
      // F5 bench record: how many pages needed the aligned-write erase fallback.
      const fallback = report.erases.filter((r) => r.path === 'aligned-write').length;
      const erasePath = fallback ? ` Erase: the page erase command did not erase; the aligned-write fallback erased ${fallback} of ${report.erases.length} pages.` : '';
      setConnStatus({
        kind: 'ok',
        text: `Installed ${verified.release.version} on ESC ${index + 1}. The whole firmware and the settings were read back and match. The ESC settings are now the pinned defaults: set the low-voltage cutoff in esc-configurator before flying.${erasePath}`,
      });
    } catch (e) {
      if (e instanceof Am32FinalVerifyError) {
        // F4: the final read-back did not match. Never "Installed"; say what state the ESC is in and how to recover.
        setConnStatus({
          kind: 'error',
          text: `INSTALL FAILED on ESC ${index + 1}. ${errText(e)} ${
            e.disabled
              ? 'The page cleared the firmware start again, so the ESC stays in its bootloader and the motor stays silent.'
              : 'The page could not clear the firmware start: the ESC may run a damaged firmware. Keep props off and do not fly.'
          } Recovery: disconnect, unplug the battery, plug it back in (props off) and read the ESCs again; then retry Install, or flash the verified file with esc-configurator. If the ESC is not detected any more, it needs an SWD reflash (see the bench sheet). Note this result on the bench sheet.`,
        });
        return;
      }
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
        <ChoiceLadder
          className="flash-ladder"
          ariaLabel="Choose your ESC"
          disabledGroup={busy}
          tabbableKey={esc?.target ?? ESC_TARGETS[0]?.target}
          onSelect={(key) => {
            const t = ESC_TARGETS.find((x) => x.target === key);
            if (t) chooseEsc(t);
          }}
          items={ESC_TARGETS.map((t) => {
            // The 30x30 stays the shop's coming-soon card until a release is pinned for it (staging bench only so far).
            // F7: the staging manifest only after mount (`staging`), so server and first client render agree.
            const shown = staging ? releasesFor(t.target) : FIRMWARE_MANIFEST.filter((r) => r.target === t.target);
            const unavailable = !!t.comingSoonUntilPinned && !shown.some(isPublished);
            return {
              key: t.target,
              name: t.displayName.replace(/ \(.*\)$/, '').replace('OpenESC-', 'OpenESC ').replace('x', '×'),
              // The firmware it runs (the 30x30 runs the 20x20 image), not the page key. None on a coming-soon card (as before).
              tag: unavailable ? undefined : t.firmwareName,
              selected: esc?.target === t.target,
              disabled: unavailable,
              tone: unavailable ? ('comingsoon' as const) : undefined,
              flag: unavailable ? 'Coming soon' : undefined,
            };
          })}
        />
      </Step>

      <Step id="esc" n={2} title="Get the firmware" open={!!esc}>
        {esc && !releases.length ? <p className="text-[15px]">No firmware is listed for this ESC.</p> : null}
        {releases.map((r) => (
          <div key={r.version} className="mt-2">
            {isPublished(r) ? (
              <button type="button" className="btn-primary btn-sm" onClick={() => void prepare(r)} disabled={busy}>
                Download and verify {r.version}
              </button>
            ) : (
              <p>Not published yet.</p>
            )}
            {/* The 30x30 runs the 20x20 image; the page can't tell the sizes apart (status line, not body copy). */}
            {esc && esc.target !== esc.firmwareName ? (
              <p className="flash-filename" role="status">
                30×30 uses the 20×20 file.
              </p>
            ) : null}
            <details className="flash-more">
              <summary>Details</summary>
              <p className="mt-2">
                AM32 {r.version}, target <code>{esc?.firmwareName ?? r.target}</code>.
                {isPublished(r) ? (
                  <>
                    {' '}
                    SHA-256 <span className="flash-filename">{r.sha256}</span>
                    {r.eepromDefaults ? (
                      <>
                        EEPROM defaults SHA-256 <span className="flash-filename">{r.eepromDefaults.sha256}</span>
                      </>
                    ) : null}
                  </>
                ) : null}
              </p>
            </details>
          </div>
        ))}
        <StatusLine status={fwStatus} />
      </Step>

      <Step id="esc" n={3} title="Install with esc-configurator" open={!!verifiedForEsc}>
        {verifiedForEsc ? (
          <ol className="list-decimal pl-6 text-[16px]">
            <li>
              Props off, flight battery plugged in. Installing resets the ESC settings; set the low-voltage cutoff
              afterwards (the default is off).
            </li>
            <li>
              <button type="button" className="btn-primary btn-sm" onClick={() => saveBytes(verifiedForEsc.bytes, verifiedForEsc.fileName)}>
                Save firmware (.{verifiedForEsc.fileName.split('.').pop()})
              </button>
              <span className="flash-filename">{verifiedForEsc.fileName}</span>
            </li>
            <li>
              Open{' '}
              <a href={ESC_CONFIGURATOR_URL} target="_blank" rel="noopener noreferrer" className="underline">
                esc-configurator.com
              </a>
              , connect through the flight controller, read the ESCs, then <em>Flash all</em> with the saved file.
            </li>
          </ol>
        ) : null}
      </Step>

      {hasSerial ? (
        <Step id="esc" n={4} title="Check your ESCs (optional, Chrome or Edge)" open={!!esc}>
          {esc ? (
            <details className="flash-more">
              <summary>Read the ESCs from this page</summary>
              <p className="mt-2">
                Props off, battery in, then Read. Shows each ESC&apos;s chip and firmware name; changes nothing.
              </p>
              <p className="mt-2">
                Click <strong>Disconnect</strong> when done. Closed the tab instead? Unplug USB and the battery.
              </p>
              <p className="mt-3">Connected through</p>
              <ChoiceLadder
                className="flash-ladder"
                ariaLabel="Connected through"
                disabledGroup={busy}
                tabbableKey={via}
                onSelect={(key) => setVia(key === 'adapter' ? 'adapter' : 'fc')}
                items={[
                  {key: 'fc', name: 'The flight controller', tag: 'Betaflight, USB', selected: via === 'fc'},
                  {key: 'adapter', name: 'A USB link adapter', tag: 'on the ESC signal pad', selected: via === 'adapter'},
                ]}
              />
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
            </details>
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
      <BlockedReasons title="Install from this page not available. Use esc-configurator:" reasons={gate.reasons} />
      {gate.allowed ? (
        <p className="mt-2">
          <strong>Installing resets the ESC settings.</strong> Set the low-voltage cutoff afterwards (the default is off).
        </p>
      ) : null}
      {gate.allowed ? (
        <button type="button" className="btn-primary btn-sm mt-2" onClick={onWrite} disabled={writing !== null}>
          Install on ESC {id.index + 1}
        </button>
      ) : null}
    </li>
  );
}
