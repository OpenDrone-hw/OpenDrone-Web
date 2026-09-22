import {Link, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/legal';
import {getCompanyIdentity} from '~/lib/company';
import {CompanyFooterBlock} from '~/components/CompanyFooterBlock';
import {buildSeoMeta} from '~/lib/seo';
import {
  alternateLocaleTags,
  getLocaleFromRequest,
  langCookieHeader,
  localeFromPathname,
  seoLocaleTag,
  type Locale,
} from '~/lib/i18n';

const META = {
  en: {
    title: 'Legal / Imprint',
    description:
      'Legal identification of the seller behind the OpenDrone webshop and an overview of all legal pages.',
  },
  nl: {
    title: 'Juridisch / Colofon',
    description:
      'Juridische identificatie van de verkoper achter de OpenDrone-webshop en overzicht van alle juridische pagina’s.',
  },
  fr: {
    title: 'Mentions légales',
    description:
      'Identification juridique du vendeur derrière la boutique OpenDrone et aperçu de toutes les pages légales.',
  },
} as const;

export const meta: Route.MetaFunction = ({data}) => {
  const locale: Locale = data?.locale ?? 'en';
  const m = META[locale];
  return buildSeoMeta({
    title: m.title,
    description: m.description,
    locale: seoLocaleTag(locale),
    alternateLocales: alternateLocaleTags(locale),
  });
};

export async function loader({context, request}: Route.LoaderArgs) {
  const url = new URL(request.url);
  const existing = localeFromPathname(url.pathname);
  if (!existing) {
    const locale = getLocaleFromRequest(request);
    throw redirect(`/${locale}/legal`, {
      status: 302,
      headers: {'Set-Cookie': langCookieHeader(locale)},
    });
  }
  const company = getCompanyIdentity(
    context.env as unknown as Record<string, string | undefined>,
  );
  return {company, locale: existing as Locale};
}

type PageEntry = {
  slug: string;
  label: Record<Locale, string>;
  desc: Record<Locale, string>;
};

const PAGES: PageEntry[] = [
  {
    slug: 'algemene-voorwaarden',
    label: {en: 'Terms & Conditions', nl: 'Algemene Voorwaarden', fr: 'Conditions Générales'},
    desc: {
      en: 'B2C sale terms, ordering, delivery, warranty, complaints.',
      nl: 'Verkoopvoorwaarden B2C, bestelproces, levering, garantie, klachten.',
      fr: 'Conditions de vente B2C, commande, livraison, garantie, plaintes.',
    },
  },
  {
    slug: 'privacy',
    label: {en: 'Privacy Policy', nl: 'Privacybeleid', fr: 'Politique de Confidentialité'},
    desc: {
      en: 'GDPR: which personal data we process and why.',
      nl: 'GDPR: welke persoonsgegevens wij verwerken en waarom.',
      fr: 'RGPD : quelles données personnelles nous traitons et pourquoi.',
    },
  },
  {
    slug: 'cookies',
    label: {en: 'Cookie Policy', nl: 'Cookiebeleid', fr: 'Politique de Cookies'},
    desc: {
      en: 'List of cookies the webshop sets.',
      nl: 'Lijst van cookies die de webshop plaatst.',
      fr: 'Liste des cookies utilisés par la boutique.',
    },
  },
  {
    slug: 'herroepingsrecht',
    label: {en: 'Right of Withdrawal', nl: 'Herroepingsrecht', fr: 'Droit de Rétractation'},
    desc: {
      en: '14-day cooling-off period and model withdrawal form.',
      nl: '14-dagen bedenktijd + modelformulier voor herroeping.',
      fr: 'Délai de rétractation de 14 jours + formulaire type.',
    },
  },
  {
    slug: 'shipping',
    label: {en: 'Shipping & Delivery', nl: 'Verzending & Levering', fr: 'Expédition & Livraison'},
    desc: {
      en: 'Shipping zones, times and responsibility.',
      nl: 'Verzendzones, leveringstermijnen en risico.',
      fr: 'Zones d’expédition, délais et responsabilité.',
    },
  },
  {
    slug: 'warranty',
    label: {en: 'Warranty', nl: 'Garantie', fr: 'Garantie'},
    desc: {
      en: '2-year legal guarantee of conformity.',
      nl: '2-jarige wettelijke conformiteitsgarantie.',
      fr: 'Garantie légale de conformité de 2 ans.',
    },
  },
  {
    slug: 'end-use',
    label: {en: 'End-Use Policy', nl: 'End-Use Beleid', fr: 'Politique d’Usage Final'},
    desc: {
      en: 'Permitted and excluded end-uses for Incutec goods.',
      nl: 'Toegestaan en uitgesloten eindgebruik voor Incutec-goederen.',
      fr: 'Usages finaux autorisés et exclus pour les biens Incutec.',
    },
  },
  {
    slug: 'security',
    label: {en: 'Security', nl: 'Beveiliging', fr: 'Sécurité'},
    desc: {
      en: 'Coordinated vulnerability disclosure (CRA).',
      nl: 'Gecoördineerde kwetsbaarheidsmelding (CRA).',
      fr: 'Divulgation coordonnée des vulnérabilités (CRA).',
    },
  },
  {
    slug: 'cookie-settings',
    label: {en: 'Cookie settings', nl: 'Cookie-instellingen', fr: 'Paramètres des cookies'},
    desc: {
      en: 'Overview and reset of session cookies.',
      nl: 'Overzicht en reset van sessie-cookies.',
      fr: 'Aperçu et réinitialisation des cookies de session.',
    },
  },
];

const CHROME = {
  en: {
    pageTitle: 'Legal',
    eyebrow: 'Legal · Imprint',
    seller: 'Seller',
    pages: 'Pages',
    shopNote: null,
    intro: (companyName: string) =>
      `OpenDrone is a product brand operated by ${companyName}. All orders are sold by the legal entity below.`,
  },
  nl: {
    pageTitle: 'Juridisch',
    eyebrow: 'Juridisch · Colofon',
    seller: 'Verkoper',
    pages: 'Pagina’s',
    shopNote: {
      text: 'De winkel is in het Engels. De juridische teksten hieronder zijn in het Nederlands.',
      back: 'Naar de winkel',
    },
    intro: (companyName: string) =>
      `OpenDrone is een merk uitgebaat door ${companyName}. Alle bestellingen worden verkocht door onderstaande juridische entiteit.`,
  },
  fr: {
    pageTitle: 'Mentions légales',
    eyebrow: 'Juridique · Mentions',
    seller: 'Vendeur',
    pages: 'Pages',
    shopNote: {
      text: 'La boutique est en anglais. Les textes juridiques ci-dessous sont en français.',
      back: 'Vers la boutique',
    },
    intro: (companyName: string) =>
      `OpenDrone est une marque exploitée par ${companyName}. Toutes les commandes sont vendues par l’entité juridique ci-dessous.`,
  },
} as const;

export default function LegalIndex() {
  const {company, locale} = useLoaderData<typeof loader>();
  const t = CHROME[locale];
  return (
    <div className="legal-index page-shell">
      <header className="page-header">
        <p className="page-eyebrow">{t.eyebrow}</p>
        <h1 className="page-title">{t.pageTitle}</h1>
        <p className="page-description">{t.intro(company.name)}</p>
        {t.shopNote ? (
          <p className="page-description">
            {t.shopNote.text}{' '}
            <Link to="/" hrefLang="en" prefetch="intent">
              {t.shopNote.back}
            </Link>
          </p>
        ) : null}
      </header>

      <section className="legal-identity" style={{marginBottom: '2.5rem'}}>
        <h2 className="section-heading">{t.seller}</h2>
        <CompanyFooterBlock company={company} />
      </section>

      <section>
        <h2 className="section-heading">{t.pages}</h2>
        <div className="policies-grid">
          {PAGES.map((p) => (
            <article className="policy-card" key={p.slug}>
              <Link prefetch="viewport" to={`/${locale}/${p.slug}`}>
                <strong>{p.label[locale]}</strong>
              </Link>
              <p style={{marginTop: '0.35rem', fontSize: '0.8rem'}}>
                {p.desc[locale]}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
