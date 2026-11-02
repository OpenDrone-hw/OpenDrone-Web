/**
 * /flash: install verified firmware on OpenDrone boards from the browser.
 *
 *   - Flight controller (OpenFC-Lite / Lite Mini, Betaflight): verified UF2
 *     download + drag-and-drop onto the BOOTSEL drive (every browser);
 *     direct WebUSB PICOBOOT write only behind hardware-verify flags.
 *   - ESC (OpenESC, AM32): verified file for esc-configurator.com; read-only
 *     ESC check over Web Serial; direct 4-way write only behind
 *     AM32_*_VERIFIED flags.
 *
 * Firmware comes from the pinned manifest (app/lib/flasher/firmware-manifest.ts).
 * Placeholder entries show "firmware not published yet" and cannot be
 * downloaded or written. All write decisions live in app/lib/flasher/gates.ts.
 *
 * The page sends `usb=(self), serial=(self)` in Permissions-Policy (only this
 * path; see entry.server.tsx). A client-side navigation keeps the previous
 * document's policy, so the page checks and offers a reload.
 *
 * Accessibility: one polite live region for progress, role="alert" for
 * errors, every state spelled out in text, focus moves to each step's heading
 * when it opens, all controls are native.
 */

import {useCallback, useEffect, useState} from 'react';
import type {Route} from './+types/flash';
import {ChoiceLadder} from '~/components/ChoiceLadder';
import {isWebSerialAvailable} from '~/lib/flasher/msp';
import {isWebUsbAvailable} from '~/lib/flasher/picoboot';
import {policyAllows} from '~/lib/flasher/targets';
import {EscFlasher} from '~/lib/flasher/ui/EscFlasher';
import {FcFlasher} from '~/lib/flasher/ui/FcFlasher';
import {InfoCallout, StagingBenchNotice} from '~/lib/flasher/ui/status';
import {buildSeoMeta} from '~/lib/seo';

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: 'Update firmware',
    description: 'Install verified firmware on an OpenFC flight controller or an OpenESC from the browser.',
    robots: 'noindex, nofollow',
  });

type Product = 'fc' | 'esc';

export default function FlashRoute() {
  const [checked, setChecked] = useState(false);
  const [hasUsb, setHasUsb] = useState(false);
  const [hasSerial, setHasSerial] = useState(false);
  const [blockedByPolicy, setBlockedByPolicy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [product, setProduct] = useState<Product>('fc');
  /** A device is open or being written: switching product would unmount it mid-operation. */
  const [busy, setBusy] = useState(false);
  const say = useCallback((text: string) => setAnnounce(text), []);

  useEffect(() => {
    setChecked(true);
    setHasUsb(isWebUsbAvailable());
    setHasSerial(isWebSerialAvailable());
    setBlockedByPolicy((!!navigator.usb && !policyAllows('usb')) || (!!navigator.serial && !policyAllows('serial')));
  }, []);

  return (
    <article className="page-shell flash-page">
      <div className="reading-column flash-column">
        <StagingBenchNotice />
        <header className="page-header">
          <p className="page-eyebrow">Firmware</p>
          <h1 className="page-title">Update firmware</h1>
        </header>

        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {announce}
        </div>

        <p className="mt-4 max-w-[68ch] text-[16px]">
          Every file on this page is checked against a pinned SHA-256 before you get it. Take the propellers off before
          you start.
        </p>
        {blockedByPolicy ? (
          <InfoCallout role="alert">
            <strong>USB access needs a fresh page load.</strong>{' '}
            <button type="button" className="underline" onClick={() => window.location.reload()}>
              Reload this page
            </button>
          </InfoCallout>
        ) : checked && !hasUsb && !hasSerial ? (
          <InfoCallout>
            <strong>This browser cannot talk to USB devices directly</strong> (Safari and Firefox cannot). The download
            method works in every browser.
          </InfoCallout>
        ) : null}

        <div className="mt-6">
          <h2 className="mb-2 text-[15px] font-semibold">What are you updating?</h2>
          <ChoiceLadder
            className="flash-ladder"
            ariaLabel="What are you updating?"
            disabledGroup={busy}
            tabbableKey={product}
            onSelect={(key) => setProduct(key as Product)}
            items={[
              {key: 'fc', name: 'Flight controller', selected: product === 'fc'},
              {key: 'esc', name: 'ESC', selected: product === 'esc'},
            ]}
          />
        </div>

        {product === 'fc' ? (
          <FcFlasher hasUsb={hasUsb} hasSerial={hasSerial} say={say} onBusyChange={setBusy} />
        ) : (
          <EscFlasher hasSerial={hasSerial} say={say} onBusyChange={setBusy} />
        )}
      </div>
    </article>
  );
}
