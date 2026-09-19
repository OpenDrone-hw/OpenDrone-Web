/**
 * Theme plumbing for the light/dark split.
 *
 * The site is dark, always, until the visitor says otherwise. Light mode is
 * opt-in via the header toggle and persisted in localStorage. The OS
 * `prefers-color-scheme` is deliberately ignored: dark is the brand look, and
 * light is a choice someone makes here, not one their laptop makes for them.
 *
 * The actual palette lives in app.css: dark values are the `@theme`
 * defaults, light values override them under `html.light`. Everything the UI
 * draws goes through `var(--color-*)`, so flipping the class on <html>
 * re-themes the whole tree without per-component work.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'od-theme';

/** <meta name="theme-color"> per mode - browser chrome / mobile status bar. */
export const THEME_COLORS: Record<Theme, string> = {
  dark: '#0d0d10',
  light: '#f7f6f3',
};

/**
 * Inline, render-blocking script injected into <head> before the stylesheet.
 * Resolves the theme and writes the class onto <html> synchronously so the
 * first paint is already correct - no dark→light flash for a visitor who
 * chose light. Kept dependency-free and tiny; runs once, before hydration.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var key = ${JSON.stringify(THEME_STORAGE_KEY)};
    var stored = localStorage.getItem(key);
    var theme = stored === 'light' ? 'light' : 'dark';
    var root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? ${JSON.stringify(
      THEME_COLORS.light,
    )} : ${JSON.stringify(THEME_COLORS.dark)});
  } catch (e) {}
})();
`.trim();

/** Read the active theme from the DOM (client only). Defaults to dark. */
export function getActiveTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light') ? 'light' : 'dark';
}

/** Apply a theme to the DOM and persist the explicit choice. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / storage disabled - theme still applies for this session.
  }
}
