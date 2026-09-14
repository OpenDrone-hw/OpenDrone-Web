import {useEffect, useState} from 'react';
import {useLoaderData} from 'react-router';
import type {Route} from './+types/cookie-settings';
import {buildSeoMeta} from '~/lib/seo';
import {alternateLocaleTags, getLocaleFromRequest, legalLabels, localeFromPathname, seoLocaleTag, type Locale} from '~/lib/i18n';

export const meta: Route.MetaFunction = ({data}) => {
  const locale = data?.locale ?? 'en';
  const labels = legalLabels('cookie-settings', locale);
  return buildSeoMeta({
    title: labels.title,
    description: labels.description,
    locale: seoLocaleTag(locale),
    alternateLocales: alternateLocaleTags(locale),
    robots: 'noindex',
  });
};

export async function loader({request}: Route.LoaderArgs) {
  const url = new URL(request.url);
  const locale: Locale =
    localeFromPathname(url.pathname) ?? getLocaleFromRequest(request);
  return {locale};
}

type CookieRow = {name: string; value: string};

function readCookies(): CookieRow[] {
  if (typeof document === 'undefined') return [];
  return document.cookie
    .split(';')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const eq = c.indexOf('=');
      return {
        name: eq >= 0 ? c.slice(0, eq) : c,
        value: eq >= 0 ? c.slice(eq + 1) : '',
      };
    });
}

type CookieEntry = {name: string; en: string; nl: string; fr: string};

const KNOWN: CookieEntry[] = [
  {
    name: 'session',
    en: 'Stores your language and signed support-ticket session. Strictly necessary.',
    nl: 'Bewaart uw taal en ondertekende supportticketsessie. Strikt noodzakelijk.',
    fr: 'M\u00e9morise votre langue et votre session d’assistance sign\u00e9e. Strictement n\u00e9cessaire.',
  },
];

const STRINGS = {
  en: {
    eyebrow: 'Legal',
    intro: [
      'The OpenDrone webshop uses ',
      {strong: 'no marketing cookies'},
      ' and does not ask for consent; only a strictly necessary storefront session is set. The cart and checkout run on shop.incutec.com and manage their own session. Analytics runs via Plausible, which is cookieless. See also the ',
      {link: ['cookie policy', '/cookies']},
      '.',
    ],
    strictHeading: 'Strictly necessary cookies',
    currentHeading: 'Cookies currently in your browser',
    colName: 'Name',
    colPurpose: 'Purpose',
    colValue: 'Value (truncated)',
    none: 'No cookies visible for this domain from the client.',
    clearButton: 'Clear all session cookies',
    disclaimer:
      'HttpOnly cookies cannot be cleared from the client. Use your browser privacy settings for a full reset.',
  },
  nl: {
    eyebrow: 'Juridisch',
    intro: [
      'De OpenDrone-webshop gebruikt ',
      {strong: 'geen marketingcookies'},
      ' en vraagt geen toestemming; alleen een strikt noodzakelijke webshopsessie wordt geplaatst. De winkelwagen en checkout draaien op shop.incutec.com en beheren daar hun eigen sessie. Analytics loopt via Plausible, dat cookieless is. Zie ook het ',
      {link: ['cookiebeleid', '/cookies']},
      '.',
    ],
    strictHeading: 'Strikt noodzakelijke cookies',
    currentHeading: 'Cookies die momenteel in uw browser staan',
    colName: 'Naam',
    colPurpose: 'Doel',
    colValue: 'Waarde (afgekapt)',
    none: 'Geen cookies zichtbaar voor dit domein vanaf de client.',
    clearButton: 'Alle sessiecookies wissen',
    disclaimer:
      'HttpOnly-cookies kunnen niet vanuit de client gewist worden. Gebruik uw browser-privacy-instellingen voor een volledige reset.',
  },
  fr: {
    eyebrow: 'Mentions légales',
    intro: [
      'La boutique OpenDrone n’utilise ',
      {strong: 'aucun cookie marketing'},
      ' et ne demande pas de consentement ; seule une session strictement nécessaire est utilisée sur ce site. Le panier et le paiement fonctionnent sur shop.incutec.com et y gèrent leur propre session. Les statistiques passent par Plausible, sans cookies. Voir aussi la ',
      {link: ['politique en matière de cookies', '/cookies']},
      '.',
    ],
    strictHeading: 'Cookies strictement nécessaires',
    currentHeading: 'Cookies actuellement dans votre navigateur',
    colName: 'Nom',
    colPurpose: 'Usage',
    colValue: 'Valeur (tronquée)',
    none: 'Aucun cookie visible pour ce domaine depuis le client.',
    clearButton: 'Effacer tous les cookies de session',
    disclaimer:
      'Les cookies HttpOnly ne peuvent pas être effacés depuis le client. Utilisez les réglages de confidentialité de votre navigateur pour une réinitialisation complète.',
  },
} as const;

function renderIntro(parts: readonly (string | {strong: string} | {link: readonly [string, string]})[]) {
  return parts.map((p, i) => {
    if (typeof p === 'string') return p;
    if ('strong' in p) return <strong key={i}>{p.strong}</strong>;
    if ('link' in p)
      return (
        <a key={i} href={p.link[1]}>
          {p.link[0]}
        </a>
      );
    return null;
  });
}

export default function CookieSettingsRoute() {
  const {locale} = useLoaderData<typeof loader>();
  const labels = legalLabels('cookie-settings', locale);
  const t = STRINGS[locale];
  const [cookies, setCookies] = useState<CookieRow[]>([]);

  useEffect(() => {
    setCookies(readCookies());
  }, []);

  function clearAll() {
    if (typeof document === 'undefined') return;
    for (const c of cookies) {
      document.cookie = `${c.name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // ignore
    }
    setCookies(readCookies());
  }

  return (
    <div className="cookie-settings page-shell">
      <header className="page-header">
        <p className="page-eyebrow">{t.eyebrow}</p>
        <h1 className="page-title">{labels.title}</h1>
        <p className="page-description">{renderIntro(t.intro)}</p>
      </header>

      <div className="rich-content">
        <h2>{t.strictHeading}</h2>
        <table className="cookie-settings-table">
          <thead>
            <tr>
              <th>{t.colName}</th>
              <th>{t.colPurpose}</th>
            </tr>
          </thead>
          <tbody>
            {KNOWN.map((k) => (
              <tr key={k.name}>
                <td>
                  <code>{k.name}</code>
                </td>
                <td>{k[locale]}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>{t.currentHeading}</h2>
        {cookies.length === 0 ? (
          <p>{t.none}</p>
        ) : (
          <table className="cookie-settings-table">
            <thead>
              <tr>
                <th>{t.colName}</th>
                <th>{t.colValue}</th>
              </tr>
            </thead>
            <tbody>
              {cookies.map((c) => (
                <tr key={c.name}>
                  <td>
                    <code>{c.name}</code>
                  </td>
                  <td>
                    <code>{c.value.slice(0, 48)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p>
          <button
            type="button"
            onClick={clearAll}
            className="account-button"
          >
            {t.clearButton}
          </button>
        </p>
        <p style={{color: 'var(--color-text-muted)', fontSize: '0.75rem'}}>
          {t.disclaimer}
        </p>
      </div>
    </div>
  );
}
