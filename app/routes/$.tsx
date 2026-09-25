import type {Route} from './+types/$';
import {redirect} from 'react-router';
import {langCookieHeader, localeFromPathname, stripLocale} from '~/lib/i18n';

// No meta here: the thrown 404 bubbles to root's ErrorBoundary, and route
// meta below the rendering boundary is discarded - the 404 title comes
// from root.tsx's error-aware meta instead.
export async function loader({request}: Route.LoaderArgs) {
  const url = new URL(request.url);
  // The shop is in English; only the legal texts exist in Dutch and French
  // (their /nl/... and /fr/... routes are registered in app/routes.ts and
  // never reach this catch-all). A bare /nl or /fr opens the legal overview
  // in that language, and a locale-prefixed shop path opens the English page.
  const locale = localeFromPathname(url.pathname);
  if (locale) {
    const rest = stripLocale(url.pathname);
    if (rest === '/') {
      if (locale === 'en') throw redirect(`/${url.search}`, 302);
      throw redirect(`/${locale}/legal`, {
        status: 302,
        headers: {'Set-Cookie': langCookieHeader(locale)},
      });
    }
    throw redirect(`${rest}${url.search}`, 302);
  }
  throw new Response(`${url.pathname} not found`, {status: 404});
}

export default function CatchAllPage() {
  return null;
}
