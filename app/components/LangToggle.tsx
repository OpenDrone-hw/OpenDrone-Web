import {Link, useLocation} from 'react-router';
import {
  LANG_COOKIE,
  isLegalPath,
  localeFromPathname,
  swapLocale,
  stripLocale,
  type Locale,
} from '~/lib/i18n';

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function writeLangCookie(locale: Locale) {
  if (typeof document === 'undefined') return;
  document.cookie = `${LANG_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

const LABELS: Record<Locale, string> = {nl: 'NL', fr: 'FR', en: 'EN'};
const ORDER: readonly Locale[] = ['nl', 'fr', 'en'];

/**
 * NL/FR/EN language toggle for legal/regulatory pages. Renders nothing
 * on non-legal routes - the rest of the site is English-only.
 *
 * On a legal page it swaps the locale segment of the URL and refreshes
 * the preference cookie so SSR picks the right language next time.
 */
export function LangToggle({className}: {className?: string} = {}) {
  const location = useLocation();
  if (!isLegalPath(location.pathname)) return null;

  const currentLocale = localeFromPathname(location.pathname);
  const active: Locale = currentLocale ?? 'en';

  const ensurePrefix = (target: Locale) =>
    currentLocale
      ? swapLocale(location.pathname, target)
      : '/' + target + stripLocale(location.pathname);

  return (
    <div
      className={`lang-toggle${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="Language"
    >
      {ORDER.map((loc) => (
        <Link
          key={loc}
          to={ensurePrefix(loc) + location.search}
          preventScrollReset
          prefetch="viewport"
          aria-current={active === loc ? 'page' : undefined}
          onClick={() => writeLangCookie(loc)}
          data-active={active === loc ? 'true' : undefined}
        >
          {LABELS[loc]}
        </Link>
      ))}
    </div>
  );
}
