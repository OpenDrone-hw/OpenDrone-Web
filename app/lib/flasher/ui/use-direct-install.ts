import {directInstallEnabled} from '../direct-install.ts';
import {useStagingBench} from './status.tsx';

/**
 * directInstallEnabled() with the staging switch read after mount
 * (hydration-safe): false in the server render and the first client render,
 * then the real value. Used by FcFlasher and the firmware guides.
 */
export function useDirectInstallEnabled(): boolean {
  return directInstallEnabled(useStagingBench());
}
