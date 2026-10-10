import {useEffect, type ReactNode} from 'react';
import type {Theme} from '~/lib/testing/palette';
import {SITE_ORIGIN} from '~/lib/seo';
import '../../brand/testing/fonts.css';
import '../../brand/testing/tokens.css';
import '../../styles/testing.css';

/**
 * The testing page is a typeset document, like the reports the Incutec testing
 * app exports: one column, light only, the Incutec wordmark on a rule at the
 * top, no navigation bar. Brand files are vendored from the design repository
 * and scoped to `.testing-workspace`.
 */

/** The page is light only, as the exported reports are. */
export const useWorkspaceTheme = (): Theme => 'light';

export function WorkspaceShell({children}: {children: ReactNode}) {
  // A link to a section or figure lands on it even though figures above it change height as they
  // load: the jump is repeated while the page settles, and stops at the first touch of the reader.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    let live = true;
    const stop = () => {
      live = false;
    };
    const again = () => {
      if (live) document.getElementById(id)?.scrollIntoView({block: 'start'});
    };
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    events.forEach((e) => window.addEventListener(e, stop, {once: true, passive: true}));
    const timers = [150, 500, 1000, 2000].map((t) => window.setTimeout(again, t));
    return () => {
      timers.forEach(clearTimeout);
      events.forEach((e) => window.removeEventListener(e, stop));
    };
  }, []);

  return (
    <div className="testing-workspace" data-theme="light">
      <div className="tr-page">
        <header className="tr-strip">
          <a href="/testing" aria-label="Incutec testing">
            <img src="/brand/wordmark-light.svg" alt="Incutec" />
          </a>
          <span aria-hidden="true" />
        </header>
        <main className="tr-doc">{children}</main>
        <footer className="tr-end">
          <p>
            Data: <a href="/testing/index.json">index.json</a>. Back to <a href={SITE_ORIGIN}>{SITE_ORIGIN.replace('https://', '')}</a>.
          </p>
        </footer>
      </div>
    </div>
  );
}
