import {useLoaderData} from 'react-router';
import type {Route} from './+types/recycling';
import {LegalPage} from '~/components/LegalPage';
import {alternateLocaleTags, legalLabels, resolveLegalLoader, seoLocaleTag} from '~/lib/i18n';
import type {Locale} from '~/lib/i18n';
import {registrationRows, type RegistrationKind, type RegistrationsFile} from '~/lib/registrations';
import {buildSeoMeta} from '~/lib/seo';
import registrations from '../../content/registrations.json';

/** Names of the registration numbers, per language. */
const KIND_LABELS: Record<Locale, Record<RegistrationKind, string> & {title: string}> = {
  en: {title: 'Registration numbers', weee: 'WEEE', packaging: 'Packaging', idu: 'IDU'},
  nl: {title: 'Registratienummers', weee: 'AEEA', packaging: 'Verpakking', idu: 'IDU'},
  fr: {title: 'Numéros d’enregistrement', weee: 'DEEE', packaging: 'Emballages', idu: 'IDU'},
};

export const meta: Route.MetaFunction = ({data}) => {
  const locale = data?.locale ?? 'en';
  const labels = legalLabels('recycling', locale);
  return buildSeoMeta({
    title: labels.title,
    description: labels.description,
    locale: seoLocaleTag(locale),
    alternateLocales: alternateLocaleTags(locale),
    canonical: data?.canonicalUrl,
    hreflang: data?.hreflang,
  });
};

export async function loader({request}: Route.LoaderArgs) {
  const page = await resolveLegalLoader(request, 'recycling', 'recycling');
  return {...page, rows: registrationRows(registrations as RegistrationsFile, page.locale)};
}

/**
 * Recycling and take-back: the text from `app/content/legal/<locale>/
 * recycling.md`, then the producer registration numbers from
 * `content/registrations.json`. Numbers still null are not listed, and the
 * list is left out while there are none.
 */
export default function RecyclingRoute() {
  const {html, locale, rows} = useLoaderData<typeof loader>();
  const labels = legalLabels('recycling', locale);
  const kinds = KIND_LABELS[locale];
  return (
    <LegalPage eyebrow={labels.eyebrow} title={labels.title} html={html} locale={locale}>
      {rows.length ? (
        <section className="mt-8">
          <h3>{kinds.title}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[15px] [&>dd]:m-0! [&>dt]:m-0!">
            {rows.map((row) => (
              <div key={row.country} className="contents">
                <dt className="text-[var(--color-text-muted)]">{row.name}</dt>
                <dd className="font-mono text-[var(--color-text)]">
                  {row.numbers.map((n) => `${kinds[n.kind]} ${n.value}`).join(' · ')}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </LegalPage>
  );
}
