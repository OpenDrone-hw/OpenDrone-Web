import {directInstallEnabled} from '../direct-install.ts';
import {useStagingBench} from './status.tsx';

/**
 * directInstallEnabled() with the staging switch read after mount
 * (hydration-safe; the per-board part is static). Used by FcFlasher and the
 * firmware guides.
 */
export function useDirectInstallEnabled(): boolean {
  return directInstallEnabled(useStagingBench());
}
