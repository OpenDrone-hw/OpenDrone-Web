/**
 * The ONE switch that says whether the firmware page installs an OpenFC with
 * its one-button flow: the staging bench switch, or both hardware-verify
 * flags. FcFlasher (the button) and the firmware guides (their copy) read it
 * from here so they can never disagree. The write itself is still refused in
 * fc-update.ts / picoboot.ts unless the gates allow it.
 *
 * Pure: the staging switch is a parameter, read after mount by
 * useDirectInstallEnabled (ui/use-direct-install.ts), so server render and
 * first client render agree.
 */
import {CHIP_PACKAGE_VERIFIED, PICOBOOT_WRITE_VERIFIED} from './targets.ts';

export function directInstallEnabled(stagingBench: boolean): boolean {
  return stagingBench || (CHIP_PACKAGE_VERIFIED && PICOBOOT_WRITE_VERIFIED);
}
