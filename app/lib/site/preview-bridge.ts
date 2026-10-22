/**
 * The Studio's preview bridge (docs/sites.md in incutec-app): the site front shown in the Studio's preview frame tells the
 * Studio which text was clicked and takes live edits. Only with SITE_PREVIEW === '1' and a STUDIO_ORIGIN; never on production.
 *
 * Out: click on an element with `data-edit` -> `{type:'data-edit', key}` to the parent, addressed to STUDIO_ORIGIN only.
 * In: `{type:'data-edit-set', key, value}` from STUDIO_ORIGIN replaces the text of the matching elements (plain text).
 */
export function previewOrigin(env: {SITE_PREVIEW?: string; STUDIO_ORIGIN?: string}): string | null {
  if (env.SITE_PREVIEW !== '1') return null;
  try {
    const u = new URL(env.STUDIO_ORIGIN ?? '');
    return u.protocol === 'https:' || u.hostname === 'localhost' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The framing headers of an HTML page. Production: nothing may frame the site (`DENY`, `frame-ancestors 'none'`). Dev: same
 * origin. A preview Worker (`studio`, from previewOrigin): only the Studio's one origin may frame it, so the Studio can show
 * the draft; X-Frame-Options has no form for one foreign origin, so it is left out and frame-ancestors decides.
 */
export function framing(csp: string, isDev: boolean, studio: string | null): {csp: string; xfo: string | null} {
  if (studio) return {csp: csp.replace("frame-ancestors 'none'", `frame-ancestors ${studio}`), xfo: null};
  if (isDev) return {csp: csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'"), xfo: 'SAMEORIGIN'};
  return {csp, xfo: 'DENY'};
}

type El = {getAttribute(n: string): string | null; textContent: string | null; closest?(s: string): El | null};
type Win = {
  parent: unknown;
  document: {addEventListener(t: string, f: (e: any) => void, c?: boolean): void; removeEventListener(t: string, f: (e: any) => void, c?: boolean): void; querySelectorAll(s: string): Iterable<El>};
  addEventListener(t: string, f: (e: any) => void): void;
  removeEventListener(t: string, f: (e: any) => void): void;
};

/** Installs both directions; returns the cleanup. Does nothing outside a frame. */
export function installPreviewBridge(win: Win, studioOrigin: string): () => void {
  const parent = win.parent as {postMessage(m: unknown, o: string): void} | null;
  if (!parent || (parent as unknown) === win) return () => undefined;
  const onClick = (e: {target: El | null; preventDefault(): void}) => {
    const hit = e.target?.closest?.('[data-edit]');
    const key = hit?.getAttribute('data-edit');
    if (!key) return;
    e.preventDefault();
    parent.postMessage({type: 'data-edit', key}, studioOrigin);
  };
  const onMessage = (e: {origin: string; data: unknown}) => {
    if (e.origin !== studioOrigin) return;
    const d = e.data as {type?: string; key?: unknown; value?: unknown} | null;
    if (!d || d.type !== 'data-edit-set' || typeof d.key !== 'string' || typeof d.value !== 'string') return;
    for (const el of win.document.querySelectorAll('[data-edit]')) if (el.getAttribute('data-edit') === d.key) el.textContent = d.value;
  };
  win.document.addEventListener('click', onClick, true);
  win.addEventListener('message', onMessage);
  return () => {
    win.document.removeEventListener('click', onClick, true);
    win.removeEventListener('message', onMessage);
  };
}
