import {Link, useLocation} from 'react-router';
import {Txt} from '~/components/Txt';
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
 * The locale for an in-site link to a legal page. The shop pages are in
 * English, so a legal link from them opens the English text instead of
 * letting the unprefixed URL redirect by browser language; on a legal page
 * the link keeps the language the reader is already in.
 */
export function useLegalLocale(): Locale {
  const {pathname} = useLocation();
  return (isLegalPath(pathname) && localeFromPathname(pathname)) || 'en';
}

/** `to` with the locale prefix when it points at a legal page. */
export function legalHref(to: string, locale: Locale): string {
  const path = to.split(/[?#]/)[0];
  if (localeFromPathname(path) || !isLegalPath(path)) return to;
  return `/${locale}${to}`;
}

/**
 * The footer's language line: the shop is English, the legal texts exist in
 * English, Dutch and French. Each link opens the terms in that language and
 * stores the choice, so later unprefixed legal links follow it.
 */
export function LegalLanguages({className}: {className?: string} = {}) {
  const active = useLegalLocale();
  return (
    <div className={className}>
      <Txt
        id="chrome.footer_legal_languages"
        fallback="The shop is in English. Legal texts:"
      />{' '}
      {(['en', 'nl', 'fr'] as const).map((loc, i) => (
        <span key={loc}>
          {i > 0 ? ' / ' : null}
          <Link
            to={`/${loc}/algemene-voorwaarden`}
            hrefLang={loc}
            lang={loc}
            onClick={() => writeLangCookie(loc)}
            aria-current={active === loc ? 'true' : undefined}
            className="underline underline-offset-2 hover:text-[var(--color-text)]"
          >
            {LEGAL_LANGUAGE_NAMES[loc]}
          </Link>
        </span>
      ))}
    </div>
  );
}

/** Each language in its own words: a reader looks for the name they know. */
const LEGAL_LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  nl: 'Nederlands',
  fr: 'Français',
};

/**
 * NL/FR/EN language toggle. On a legal page it swaps the locale segment of
 * the URL and refreshes the preference cookie so SSR picks the right
 * language next time.
 *
 * The rest of the shop is in English only, so on any other page EN is the
 * active language and NL / FR open the legal overview in that language,
 * with a title that says so: a Dutch or French reader finds the texts that
 * exist in their language from the header, not only from the footer.
 */
export function LangToggle({
  className,
  shopPages = true,
  shopWrapperClassName,
}: {
  className?: string;
  /** Render the shop-page variant; false renders nothing off legal pages. */
  shopPages?: boolean;
  /** Wraps the shop-page variant, for a breakpoint the header row needs. */
  shopWrapperClassName?: string;
} = {}) {
  const location = useLocation();
  if (!isLegalPath(location.pathname)) {
    if (!shopPages) return null;
    return (
      <div className={shopWrapperClassName}>
        <ShopLangToggle className={className} />
      </div>
    );
  }

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

/** Per language: what its link opens from a page that exists in English only. */
const SHOP_LANG_TITLES: Record<Locale, string> = {
  en: 'The shop is in English.',
  nl: 'De winkel is in het Engels. Juridische teksten in het Nederlands.',
  fr: 'La boutique est en anglais. Textes juridiques en français.',
};

/** The toggle on a shop page: EN is where the reader is, NL and FR open the
 *  legal overview in that language. */
function ShopLangToggle({className}: {className?: string}) {
  const {pathname, search} = useLocation();
  const here = pathname + search;
  return (
    <div
      className={`lang-toggle${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="Language. The shop is in English; legal texts in English, Dutch and French."
    >
      {ORDER.map((loc) =>
        loc === 'en' ? (
          <Link
            key={loc}
            to={here}
            preventScrollReset
            lang="en"
            title={SHOP_LANG_TITLES.en}
            aria-current="page"
            data-active="true"
          >
            {LABELS.en}
          </Link>
        ) : (
          <Link
            key={loc}
            to={`/${loc}/legal`}
            hrefLang={loc}
            lang={loc}
            title={SHOP_LANG_TITLES[loc]}
            aria-label={SHOP_LANG_TITLES[loc]}
            prefetch="intent"
            onClick={() => writeLangCookie(loc)}
          >
            {LABELS[loc]}
          </Link>
        ),
      )}
    </div>
  );
}
