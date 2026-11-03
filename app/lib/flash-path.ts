/**
 * Where the web flasher lives, and the paths that only it may use USB/serial on.
 * Shared by app/routes.ts (old-URL redirects), entry.server.tsx
 * (Permissions-Policy) and the links that need a full document load.
 */
export const FLASH_PATH = '/guides/flash';

/** Old flasher URLs that 301 to FLASH_PATH. */
export const LEGACY_FLASH_PATHS = ['/flash', '/en/flash', '/nl/flash', '/fr/flash'] as const;

/** The redirect target for a legacy flasher URL: FLASH_PATH plus the original query. */
export function flashRedirectTarget(requestUrl: string): string {
  return `${FLASH_PATH}${new URL(requestUrl).search}`;
}

/**
 * True only for the flasher page itself. Trailing slashes are ignored (F10):
 * React Router also serves `/guides/flash/`, and a blocked policy there would
 * make the page's "Reload" advice loop forever.
 */
export function isFlashPage(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === FLASH_PATH;
}

/** `serial`/`usb` Permissions-Policy entries for a request path. */
export function devicePolicyFor(pathname: string): string {
  return isFlashPage(pathname) ? 'serial=(self), usb=(self)' : 'serial=(), usb=()';
}

/** Links to the flasher must be a full document load (prefetch off) so the policy applies. */
export function isFlashHref(href: string): boolean {
  return href === FLASH_PATH || href.startsWith(`${FLASH_PATH}/`) || href.startsWith(`${FLASH_PATH}#`) || href.startsWith(`${FLASH_PATH}?`);
}
