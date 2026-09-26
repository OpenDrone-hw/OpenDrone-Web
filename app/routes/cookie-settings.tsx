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
    name: 'cart',
    en: 'Links your cart to your browser session. Strictly necessary.',
    nl: 'Koppelt uw winkelwagen aan uw browsersessie. Strikt noodzakelijk.',
    fr: 'Associe votre panier \u00e0 votre session de navigateur. Strictement n\u00e9cessaire.',
  },
  {
    name: 'cart_sig',
    en: 'Security signature for the cart cookie.',
    nl: 'Beveiligingshandtekening voor de winkelwagen-cookie.',
    fr: 'Signature de s\u00e9curit\u00e9 pour le cookie du panier.',
  },
  {
    name: '_secure_session_id',
    en: 'Session security for Shopify checkout. Strictly necessary.',
    nl: 'Sessiebeveiliging bij Shopify checkout. Strikt noodzakelijk.',
    fr: 'S\u00e9curit\u00e9 de session pour le checkout Shopify. Strictement n\u00e9cessaire.',
  },
  {
    name: 'localization',
    en: 'Remembers selected language/region for the storefront.',
    nl: 'Onthoudt de gekozen taal/regio voor de storefront.',
    fr: 'M\u00e9morise la langue/r\u00e9gion s\u00e9lectionn\u00e9e pour la boutique.',
  },
  {
    name: 'opendrone_lang',
    en: 'Remembers your NL/FR/EN preference for regulatory pages.',
    nl: 'Onthoudt uw NL/FR/EN-voorkeur voor juridische pagina\u2019s.',
    fr: 'M\u00e9morise votre pr\u00e9f\u00e9rence linguistique pour les pages l\u00e9gales.',
  },
  {
    name: 'od_support',
    en: 'Remembers which support tickets this browser may open. Set only when you open or find a ticket.',
    nl: 'Onthoudt welke supporttickets deze browser mag openen. Enkel geplaatst wanneer u een ticket opent of terugvindt.',
    fr: 'Retient les tickets de support que ce navigateur peut ouvrir. Plac\u00e9 uniquement lorsque vous ouvrez ou retrouvez un ticket.',
  },
];

const STRINGS = {
  en: {
    eyebrow: 'Legal',
    intro: [
      'The OpenDrone webshop uses ',
      {strong: 'no marketing cookies'},
      ' and does not ask for consent; only strictly-necessary cookies are set for cart and checkout. Analytics runs via Plausible, which is cookieless. See also the ',
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
      ' en vraagt geen toestemming; alleen strikt noodzakelijke cookies worden geplaatst voor winkelwagen en checkout. Analytics loopt via Plausible, dat cookieless is. Zie ook het ',
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
      ' et ne demande pas de consentement ; seuls des cookies strictement nécessaires sont utilisés pour le panier et le checkout. Les statistiques passent par Plausible, sans cookies. Voir aussi la ',
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
