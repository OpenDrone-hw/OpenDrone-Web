/**
 * Internationalisation helpers for legal pages.
 *
 * URL scheme
 * ----------
 * Legal pages are served at `/en/<slug>`, `/nl/<slug>`, and `/fr/<slug>`.
 * Unprefixed legacy URLs like `/warranty` redirect to the user's cached
 * language. Non-legal pages (home, products, cart, contact, …) remain
 * unprefixed and are English-only.
 *
 * Caching
 * -------
 * Language preference is stored in the `opendrone_lang` cookie for one
 * year. The cookie is readable by both client and server so that the
 * server can render the correct language on the first request and the
 * toggle can update it client-side without a full round-trip.
 */

import {redirect} from 'react-router';
import {loadLegal, type LegalSlug} from '~/lib/legal';
import {LEGAL_SLUGS, type LegalPathSlug} from '~/lib/legal-slugs';
import {SITE_ORIGIN} from '~/lib/seo';

export const LOCALES = ['en', 'nl', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LANG_COOKIE = 'opendrone_lang';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export {LEGAL_SLUGS, type LegalPathSlug};

function isLegalSlug(slug: string): slug is LegalPathSlug {
  return (LEGAL_SLUGS as readonly string[]).includes(slug);
}

/** Strip a leading /en or /nl segment from a pathname, if present. */
export function stripLocale(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (isLocale(segments[0])) segments.shift();
  return '/' + segments.join('/');
}

/** True if the given pathname is a translated regulatory page. */
export function isLegalPath(pathname: string): boolean {
  const segments = stripLocale(pathname).split('/').filter(Boolean);
  return segments.length >= 1 && isLegalSlug(segments[0]);
}

/**
 * Page titles, eyebrows, and short UI strings per locale for the
 * regulatory routes. Used by route meta + the LegalPage chrome so that
 * `/nl/*` pages render Dutch chrome and `/en/*` pages render English.
 * The legal body itself is untouched and comes from Markdown in
 * `app/content/legal/<locale>/<slug>.md`.
 */
const LEGAL_LABELS_FALLBACK: Record<
  LegalPathSlug,
  Record<Locale, {title: string; eyebrow: string; description: string}>
> = {
  'algemene-voorwaarden': {
    en: {
      title: 'General Terms & Conditions',
      eyebrow: 'Legal',
      description: 'Terms of sale between Incutec BV and OpenDrone customers.',
    },
    nl: {
      title: 'Algemene Voorwaarden',
      eyebrow: 'Juridisch',
      description: 'Verkoopvoorwaarden tussen Incutec BV en OpenDrone-klanten.',
    },
    fr: {
      title: 'Conditions Générales de Vente',
      eyebrow: 'Juridique',
      description: 'Conditions de vente entre Incutec BV et les clients OpenDrone.',
    },
  },
  privacy: {
    en: {
      title: 'Privacy Policy',
      eyebrow: 'Legal · GDPR',
      description: 'How Incutec BV processes personal data for the OpenDrone webshop, GDPR compliant.',
    },
    nl: {
      title: 'Privacybeleid',
      eyebrow: 'Juridisch · AVG',
      description: 'Hoe Incutec BV persoonsgegevens verwerkt voor de OpenDrone-webshop, AVG-conform.',
    },
    fr: {
      title: 'Politique de Confidentialité',
      eyebrow: 'Juridique · RGPD',
      description: 'Comment Incutec BV traite les données personnelles pour la boutique OpenDrone, conforme au RGPD.',
    },
  },
  cookies: {
    en: {
      title: 'Cookie Policy',
      eyebrow: 'Legal',
      description: 'Which cookies the OpenDrone storefront uses and why.',
    },
    nl: {
      title: 'Cookiebeleid',
      eyebrow: 'Juridisch',
      description: 'Welke cookies de OpenDrone-webshop gebruikt en waarvoor.',
    },
    fr: {
      title: 'Politique de Cookies',
      eyebrow: 'Juridique',
      description: 'Quels cookies la boutique OpenDrone utilise et pourquoi.',
    },
  },
  herroepingsrecht: {
    en: {
      title: 'Right of Withdrawal',
      eyebrow: 'Legal',
      description: '14-day withdrawal right and standard withdrawal form.',
    },
    nl: {
      title: 'Herroepingsrecht',
      eyebrow: 'Juridisch',
      description: 'Herroepingstermijn van 14 dagen en modelformulier.',
    },
    fr: {
      title: 'Droit de Rétractation',
      eyebrow: 'Juridique',
      description: 'Délai de rétractation de 14 jours et formulaire type.',
    },
  },
  shipping: {
    en: {
      title: 'Shipping & Delivery',
      eyebrow: 'Legal',
      description: 'Shipping options, delivery times, and country restrictions.',
    },
    nl: {
      title: 'Verzending & Levering',
      eyebrow: 'Juridisch',
      description: 'Verzendopties, leveringstermijnen en landbeperkingen.',
    },
    fr: {
      title: 'Expédition & Livraison',
      eyebrow: 'Juridique',
      description: 'Options d’expédition, délais de livraison et restrictions par pays.',
    },
  },
  warranty: {
    en: {
      title: 'Warranty',
      eyebrow: 'Legal',
      description: '2-year legal guarantee of conformity on OpenDrone hardware sold by Incutec BV.',
    },
    nl: {
      title: 'Garantie',
      eyebrow: 'Juridisch',
      description: 'Wettelijke conformiteitsgarantie van 2 jaar op OpenDrone-hardware verkocht door Incutec BV.',
    },
    fr: {
      title: 'Garantie',
      eyebrow: 'Juridique',
      description: 'Garantie légale de conformité de 2 ans sur le matériel OpenDrone vendu par Incutec BV.',
    },
  },
  security: {
    en: {
      title: 'Security · Vulnerability Disclosure',
      eyebrow: 'Security',
      description: 'How to report a vulnerability in OpenDrone hardware, firmware, or the webshop.',
    },
    nl: {
      title: 'Beveiliging · Kwetsbaarheidsmelding',
      eyebrow: 'Beveiliging',
      description: 'Hoe u een kwetsbaarheid kunt melden in OpenDrone-hardware, firmware of de webshop.',
    },
    fr: {
      title: 'Sécurité · Divulgation de Vulnérabilités',
      eyebrow: 'Sécurité',
      description: 'Comment signaler une vulnérabilité dans le matériel, le firmware ou la boutique OpenDrone.',
    },
  },
  'end-use': {
    en: {
      title: 'End-Use Policy',
      eyebrow: 'Legal',
      description: 'Permitted and excluded end-uses for goods supplied by Incutec BV.',
    },
    nl: {
      title: 'End-Use Beleid',
      eyebrow: 'Juridisch',
      description: 'Toegestaan en uitgesloten eindgebruik voor goederen geleverd door Incutec BV.',
    },
    fr: {
      title: 'Politique d’Usage Final',
      eyebrow: 'Juridique',
      description: 'Usages finaux autorisés et exclus pour les biens fournis par Incutec BV.',
    },
  },
  legal: {
    en: {
      title: 'Legal / Imprint',
      eyebrow: 'Legal · Imprint',
      description: 'Identity of the seller, mandatory pages, and external references.',
    },
    nl: {
      title: 'Juridisch / Colofon',
      eyebrow: 'Juridisch · Colofon',
      description: 'Identiteit van de verkoper, verplichte pagina\u2019s en externe verwijzingen.',
    },
    fr: {
      title: 'Mentions L\u00e9gales',
      eyebrow: 'Juridique \u00b7 Mentions',
      description: 'Identit\u00e9 du vendeur, pages obligatoires et r\u00e9f\u00e9rences externes.',
    },
  },
  'cookie-settings': {
    en: {
      title: 'Cookie settings',
      eyebrow: 'Legal',
      description: 'Manage your cookie preferences for the OpenDrone webshop.',
    },
    nl: {
      title: 'Cookie-instellingen',
      eyebrow: 'Juridisch',
      description: 'Beheer uw cookievoorkeuren voor de OpenDrone-webshop.',
    },
    fr: {
      title: 'Paramètres des Cookies',
      eyebrow: 'Juridique',
      description: 'Gérez vos préférences de cookies pour la boutique OpenDrone.',
    },
  },
  terms: {
    en: {
      title: 'General Terms & Conditions',
      eyebrow: 'Legal',
      description: 'Terms of sale between Incutec BV and OpenDrone customers.',
    },
    nl: {
      title: 'Algemene Voorwaarden',
      eyebrow: 'Juridisch',
      description: 'Verkoopvoorwaarden tussen Incutec BV en OpenDrone-klanten.',
    },
    fr: {
      title: 'Conditions Générales de Vente',
      eyebrow: 'Juridique',
      description: 'Conditions de vente entre Incutec BV et les clients OpenDrone.',
    },
  },
};

/**
 * The title, eyebrow and description of every legal page, in three languages.
 *
 * Loaded from `content/copy/legal-labels.json` rather than written here, so the
 * studio can edit it: these are the only page titles on the site that are not
 * reachable any other way, because the legal routes are generated rather than
 * hand-written. The Markdown bodies live in `app/content/legal/<locale>/` and
 * are edited on the studio's Legal tab.
 *
 * Guarded on `import.meta.env` like the other content loaders, so node:test can
 * import this module: there the glob never runs and the fallback below is used.
 * The JSON is now the editable source. Keep the fallback in this module aligned
 * through review and tests; do not regenerate over studio edits.
 */
const LEGAL_LABEL_FILES = import.meta.env
  ? import.meta.glob<{default: Record<string, unknown>}>(
      '/content/copy/legal-labels.json',
      {eager: true},
    )
  : {};

export const LEGAL_LABELS = (() => {
  const loaded = Object.values(LEGAL_LABEL_FILES)[0]?.default;
  if (!loaded) return LEGAL_LABELS_FALLBACK;
  // `$`-prefixed keys are studio metadata, not slugs.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(loaded)) if (!k.startsWith('$')) out[k] = v;
  return out as typeof LEGAL_LABELS_FALLBACK;
})();
/** Short UI strings shown on the legal page chrome (back link, etc.). */
export const LEGAL_UI_STRINGS: Record<
  Locale,
  {backToOverview: string; lastUpdated: string}
> = {
  en: {
    backToOverview: '← Back to legal overview',
    lastUpdated: 'Last updated',
  },
  nl: {
    backToOverview: '← Terug naar juridisch overzicht',
    lastUpdated: 'Laatst bijgewerkt',
  },
  fr: {
    backToOverview: '← Retour à l’aperçu juridique',
    lastUpdated: 'Dernière mise à jour',
  },
};

export function legalLabels(slug: LegalPathSlug, locale: Locale) {
  return LEGAL_LABELS[slug][locale];
}

export function isLocale(x: unknown): x is Locale {
  return x === 'en' || x === 'nl' || x === 'fr';
}

/**
 * Parse a Cookie header and return the cached locale, if any.
 */
export function readLocaleCookie(cookieHeader: string | null): Locale | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=(en|nl|fr)(?:;|$)`),
  );
  if (match && isLocale(match[1])) return match[1];
  return null;
}

/**
 * Best-effort detection from the Accept-Language header. Honours nl
 * and fr — everything else falls back to the default locale (en).
 */
export function detectLocaleFromAccept(accept: string | null): Locale {
  if (!accept) return DEFAULT_LOCALE;
  if (/^\s*nl(-[a-z]{2})?\b/i.test(accept)) return 'nl';
  if (/^\s*fr(-[a-z]{2})?\b/i.test(accept)) return 'fr';
  return DEFAULT_LOCALE;
}

/**
 * Map a locale to the BCP-47 / OG locale tag used in <html lang> and
 * Open Graph meta. Belgian variants for nl and fr; en stays as en_US.
 */
export function seoLocaleTag(locale: Locale): 'nl_BE' | 'fr_BE' | 'en_US' {
  if (locale === 'nl') return 'nl_BE';
  if (locale === 'fr') return 'fr_BE';
  return 'en_US';
}

/**
 * The other two locale tags, for `<link rel="alternate" hreflang>` /
 * Open Graph alternateLocales.
 */
export function alternateLocaleTags(
  locale: Locale,
): Array<'nl_BE' | 'fr_BE' | 'en_US'> {
  return (LOCALES.filter((l) => l !== locale) as Locale[]).map(seoLocaleTag);
}


/**
 * Resolve the effective locale for a request: cookie first, then
 * Accept-Language, then the default.
 */
export function getLocaleFromRequest(request: Request): Locale {
  const cookie = readLocaleCookie(request.headers.get('Cookie'));
  if (cookie) return cookie;
  return detectLocaleFromAccept(request.headers.get('Accept-Language'));
}

/**
 * Serialize the language cookie header value.
 */
export function langCookieHeader(locale: Locale): string {
  return `${LANG_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

/**
 * Extract the locale segment from a URL pathname. Returns `null` if the
 * path is not locale-prefixed.
 */
export function localeFromPathname(pathname: string): Locale | null {
  const first = pathname.split('/').filter(Boolean)[0];
  return isLocale(first) ? first : null;
}

/**
 * Replace or insert the locale segment in a pathname. Used by the
 * language toggle to build the "other language" URL for the current
 * page.
 */
export function swapLocale(pathname: string, target: Locale): string {
  const segments = pathname.split('/').filter(Boolean);
  if (isLocale(segments[0])) {
    segments[0] = target;
  } else {
    segments.unshift(target);
  }
  return '/' + segments.join('/');
}

/**
 * Standard loader helper used by every legal route. Determines the
 * effective locale, redirects unprefixed URLs to the canonical
 * locale-prefixed URL, loads the cleaned Markdown body, and returns
 * everything the component needs to render the page.
 *
 * Pass `slugPath` if the URL slug differs from the LegalSlug key
 * (e.g. cookies.tsx uses slug `cookie-policy` but serves at /cookies).
 */
export async function resolveLegalLoader(
  request: Request,
  legalSlug: LegalSlug,
  urlSlug: string,
): Promise<{
  html: string;
  locale: Locale;
  canonicalUrl: string;
  hreflang: Array<{lang: string; href: string}>;
}> {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];

  if (isLocale(first)) {
    // Already locale-prefixed; render directly.
    const html = loadLegal(legalSlug, first);
    // SEO URLs derive from SITE_ORIGIN, not the serving origin: Google must
    // index opendrone.be. The locale redirect below stays request-relative.
    const canonicalUrl = `${SITE_ORIGIN}/${first}/${urlSlug}`;
    const hreflang = [
      {lang: 'en', href: `${SITE_ORIGIN}/en/${urlSlug}`},
      {lang: 'nl', href: `${SITE_ORIGIN}/nl/${urlSlug}`},
      {lang: 'fr', href: `${SITE_ORIGIN}/fr/${urlSlug}`},
      {lang: 'x-default', href: `${SITE_ORIGIN}/en/${urlSlug}`},
    ];
    return {html, locale: first, canonicalUrl, hreflang};
  }

  // Unprefixed legacy URL — redirect to the canonical locale URL and
  // refresh the cookie so subsequent visits stick.
  const locale = getLocaleFromRequest(request);
  const qs = url.search;
  throw redirect(`/${locale}/${urlSlug}${qs}`, {
    status: 302,
    headers: {'Set-Cookie': langCookieHeader(locale)},
  });
}
