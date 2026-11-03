/**
 * The ONE switch that says whether the firmware page installs an OpenFC with
 * its one-button flow: the staging bench switch, both hardware-verify
 * flags, or per-board evidence for the pinned image. FcFlasher (the button) and the firmware guides (their copy) read it
 * from here so they can never disagree. The write itself is still refused in
 * fc-update.ts / picoboot.ts unless the gates allow it.
 *
 * Pure: the staging switch is a parameter, read after mount by
 * useDirectInstallEnabled (ui/use-direct-install.ts), so server render and
 * first client render agree.
 */
import {FIRMWARE_MANIFEST} from './firmware-manifest.ts';
import {isPublished} from './manifest.ts';
import {boardDirectInstallVerified, CHIP_PACKAGE_VERIFIED, FLASHER_TARGETS, PICOBOOT_WRITE_VERIFIED} from './targets.ts';

/**
 * With `target`: whether that board installs with one button. Without: whether
 * any OpenFC does (the button shows; startUpdate then refuses a board that
 * doesn't). Per board: the production pin for that target has a
 * DIRECT_INSTALL_VERIFIED entry for its exact SHA-256 (targets.ts). Static,
 * so server and client render agree.
 */
export function directInstallEnabled(stagingBench: boolean, target?: string): boolean {
  if (stagingBench || (CHIP_PACKAGE_VERIFIED && PICOBOOT_WRITE_VERIFIED)) return true;
  return FIRMWARE_MANIFEST.some(
    (r) =>
      (target === undefined ? FLASHER_TARGETS.some((t) => t.target === r.target) : r.target === target) &&
      isPublished(r) &&
      boardDirectInstallVerified(r),
  );
}
