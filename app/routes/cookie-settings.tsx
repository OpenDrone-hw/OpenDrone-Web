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
    name: 'od_app_cart',
    en: 'Keeps the products in your cart (variant and quantity, signed). Set when you add a product; 14 days. Strictly necessary.',
    nl: 'Bewaart de producten in uw winkelmandje (variant en aantal, ondertekend). Geplaatst wanneer u een product toevoegt; 14 dagen. Strikt noodzakelijk.',
    fr: 'Conserve les produits de votre panier (variante et quantit\u00e9, sign\u00e9es). Plac\u00e9 lorsque vous ajoutez un produit ; 14 jours. Strictement n\u00e9cessaire.',
  },
  {
    name: 'od_app_cart_options',
    en: 'Keeps your discount code, your pickup choice and the campaign source of your visit with the cart (signed). Set when you add a product from a campaign link, apply a code or choose pickup; 14 days. Strictly necessary.',
    nl: 'Bewaart uw kortingscode, uw keuze voor afhalen en de campagnebron van uw bezoek bij het winkelmandje (ondertekend). Geplaatst wanneer u een product via een campagnelink toevoegt, een code toepast of afhalen kiest; 14 dagen. Strikt noodzakelijk.',
    fr: 'Conserve votre code de r\u00e9duction, votre choix du retrait et la source de campagne de votre visite avec le panier (sign\u00e9s). Plac\u00e9 lorsque vous ajoutez un produit depuis un lien de campagne, appliquez un code ou choisissez le retrait ; 14 jours. Strictement n\u00e9cessaire.',
  },
  {
    name: 'od_app_order',
    en: 'Keeps the number and status token of your last order so the order status page opens on this device. Set when you place an order; 30 days. Strictly necessary.',
    nl: 'Bewaart het nummer en het statustoken van uw laatste bestelling, zodat de statuspagina op dit toestel opent. Geplaatst wanneer u een bestelling plaatst; 30 dagen. Strikt noodzakelijk.',
    fr: 'Conserve le num\u00e9ro et le jeton de suivi de votre derni\u00e8re commande afin que la page de suivi s\u2019ouvre sur cet appareil. Plac\u00e9 lorsque vous passez une commande ; 30 jours. Strictement n\u00e9cessaire.',
  },
  {
    name: 'od_app_acct',
    en: 'Keeps you signed in to your OpenDrone account. Set only when you sign in with the code or link we email you; 30 days. Strictly necessary.',
    nl: 'Houdt u aangemeld bij uw OpenDrone-account. Enkel geplaatst wanneer u zich aanmeldt met de code of link die wij u mailen; 30 dagen. Strikt noodzakelijk.',
    fr: 'Vous garde connect\u00e9 \u00e0 votre compte OpenDrone. Plac\u00e9 uniquement lorsque vous vous connectez avec le code ou le lien que nous vous envoyons par e-mail ; 30 jours. Strictement n\u00e9cessaire.',
  },
  {
    name: 'opendrone_lang',
    en: 'Remembers your NL/FR/EN preference for regulatory pages.',
    nl: 'Onthoudt uw NL/FR/EN-voorkeur voor juridische pagina\u2019s.',
    fr: 'M\u00e9morise votre pr\u00e9f\u00e9rence linguistique pour les pages l\u00e9gales.',
  },
  {
    name: 'od_ship_country',
    en: 'Remembers the delivery country you picked, so prices, shipping and availability are shown for it. Set only when you pick a country; 1 year. Strictly necessary.',
    nl: 'Onthoudt het leverland dat u koos, zodat prijzen, verzending en beschikbaarheid ervoor worden getoond. Enkel geplaatst wanneer u een land kiest; 1 jaar. Strikt noodzakelijk.',
    fr: 'M\u00e9morise le pays de livraison que vous avez choisi, afin d\u2019afficher les prix, l\u2019exp\u00e9dition et la disponibilit\u00e9 pour ce pays. Plac\u00e9 uniquement lorsque vous choisissez un pays ; 1 an. Strictement n\u00e9cessaire.',
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
