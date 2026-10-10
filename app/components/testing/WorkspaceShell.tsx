import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from 'react';
import type {Theme} from '~/lib/testing/palette';
import {useNonce} from '~/lib/csp';
import {SITE_ORIGIN} from '~/lib/seo';
import type {TestingIndex} from '~/lib/testing/types';
import '../../brand/testing/fonts.css';
import '../../brand/testing/tokens.css';
import '../../brand/testing/topbar.css';
import '../../styles/testing.css';

/**
 * The Incutec testing workspace: its own page, outside the storefront layout.
 * Light unless the visitor chose otherwise here or on the storefront (`od-theme`).
 * The choice is kept in this browser only. A tiny script in front of the page
 * applies a stored dark choice before first paint, so there is no light flash.
 * Brand files are vendored from the design repository and scoped to
 * `.testing-workspace`.
 */

const THEME_KEY = 'incutec-testing-theme';
const STORE_KEY = 'od-theme';

const ThemeContext = createContext<Theme>('light');
export const useWorkspaceTheme = () => useContext(ThemeContext);

function stored(): Theme | null {
  try {
    for (const k of [THEME_KEY, STORE_KEY]) {
      const v = localStorage.getItem(k);
      if (v === 'dark' || v === 'light') return v;
    }
  } catch {
    /* storage can be blocked */
  }
  return null;
}

const PRE_PAINT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t!=='dark'&&t!=='light')t=localStorage.getItem(${JSON.stringify(STORE_KEY)});if(t==='dark'||t==='light')document.currentScript.parentElement.setAttribute('data-theme',t)}catch(e){}})()`;

export function WorkspaceShell({index, children}: {index: TestingIndex; children: ReactNode}) {
  const nonce = useNonce();
  const [theme, setTheme] = useState<Theme>('light');
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    const t = stored();
    if (t) setTheme(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private window: the choice lasts for this page view */
      }
      return next;
    });
  }, []);

  // Mark the product whose section is under the bar.
  useEffect(() => {
    const els = [...index.products.map((p) => p.handle), 'log']
      .map((id) => document.getElementById(id))
      .filter((e): e is HTMLElement => Boolean(e));
    if (!els.length || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      {rootMargin: '-72px 0px -70% 0px'},
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [index.products]);

  // Keep the active chip in view in the scrolling nav on a phone.
  useEffect(() => {
    document.querySelector('.tw-bar [aria-current="location"]')?.scrollIntoView?.({inline: 'center', block: 'nearest'});
  }, [active]);

  return (
    <ThemeContext.Provider value={theme}>
      <div className="testing-workspace" data-theme={theme} suppressHydrationWarning>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{__html: PRE_PAINT}} />
        <header className="incutec-topbar tw-bar">
          <span className="incutec-topbar__line" />
          <a className="incutec-topbar__brand" href="/testing" aria-label="Incutec testing">
            <img className="incutec-topbar__wordmark incutec-topbar__wordmark--light" src="/brand/wordmark-light.svg" alt="Incutec" />
            <img className="incutec-topbar__wordmark incutec-topbar__wordmark--dark" src="/brand/wordmark-dark.svg" alt="" />
          </a>
          <span className="tw-bar-title">Testing</span>
          <nav className="incutec-topbar__nav" aria-label="Products">
            {index.products.map((p) => (
              <a key={p.handle} href={`#${p.handle}`} aria-current={active === p.handle ? 'location' : undefined}>
                {p.name}
              </a>
            ))}
            <a href="#log" aria-current={active === 'log' ? 'location' : undefined}>
              Log
            </a>
          </nav>
          <div className="incutec-topbar__end">
            <button type="button" className="tw-btn" onClick={toggle} aria-pressed={theme === 'dark'}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <a className="tw-return" href={SITE_ORIGIN}>
              {SITE_ORIGIN.replace('https://', '')}
            </a>
          </div>
        </header>
        <main className="tw-main">{children}</main>
        <footer className="tw-foot">
          <span>Single units. Read the caveats.</span>
          <a href="/testing/index.json">index.json</a>
        </footer>
      </div>
    </ThemeContext.Provider>
  );
}
