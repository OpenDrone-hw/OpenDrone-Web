import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from 'react';
import type {Theme} from '~/lib/testing/palette';
import {summarize} from '~/lib/testing/select';
import type {TestingIndex} from '~/lib/testing/types';
import {SITE_ORIGIN} from '~/lib/seo';
import '../../brand/testing/fonts.css';
import '../../brand/testing/tokens.css';
import '../../brand/testing/topbar.css';
import '../../styles/testing.css';

/**
 * The Incutec testing workspace: its own page, outside the storefront layout.
 * Light by default; the choice is kept in this browser only. Brand files are
 * vendored from the design repository and scoped to `.testing-workspace`.
 */

const THEME_KEY = 'incutec-testing-theme';

const ThemeContext = createContext<Theme>('light');
export const useWorkspaceTheme = () => useContext(ThemeContext);

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function WorkspaceShell({index, children}: {index: TestingIndex; children: ReactNode}) {
  const [theme, setTheme] = useState<Theme>('light');
  const [active, setActive] = useState<string>('');
  const sum = summarize(index);

  useEffect(() => setTheme(readTheme()), []);

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
    const els = index.products
      .map((p) => document.getElementById(p.handle))
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

  return (
    <ThemeContext.Provider value={theme}>
      <div className="testing-workspace" data-theme={theme}>
        <header className="incutec-topbar tw-bar" data-variant="stroke">
          <a className="incutec-topbar__brand" href="/testing" aria-label="Incutec testing">
            <img className="incutec-topbar__wordmark incutec-topbar__wordmark--light" src="/brand/wordmark-light.svg" alt="Incutec" />
            <img className="incutec-topbar__wordmark incutec-topbar__wordmark--dark" src="/brand/wordmark-dark.svg" alt="" />
          </a>
          <span className="incutec-topbar__line" />
          <nav className="incutec-topbar__nav" aria-label="Products">
            <span className="tw-bar-title">Testing</span>
            {index.products.map((p) => (
              <a key={p.handle} href={`#${p.handle}`} aria-current={active === p.handle ? 'location' : undefined}>
                {p.name}
              </a>
            ))}
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
        <main className="tw-main">
          <p className="tw-summary" aria-label="Summary">
            <span>{sum.products} products</span>
            <span>{sum.figures} figures</span>
            <span>{sum.runs} runs</span>
            <span>last run {sum.lastRun}</span>
          </p>
          {children}
        </main>
        <footer className="tw-foot">
          <span>Single units. Read the caveats.</span>
          <a href="/testing/index.json">index.json</a>
        </footer>
      </div>
    </ThemeContext.Provider>
  );
}
