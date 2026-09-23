import {useLoaderData} from 'react-router';
import type {Route} from './+types/shipping';
import {LegalPage} from '~/components/LegalPage';
import {alternateLocaleTags, legalLabels, resolveLegalLoader, seoLocaleTag} from '~/lib/i18n';
import {buildSeoMeta} from '~/lib/seo';
import {copy} from '~/lib/copy';
import type {Locale} from '~/lib/i18n';

type Glance = {title: string; rows: Array<[string, string]>};

/** Three rows above the shipping terms: when each kind of product ships
 *  and that outside the EU it goes through shops. The rates are the table
 *  below; the terms stay the text that applies. Words in
 *  content/copy/legal-labels.json. */
function ShippingGlance({locale}: {locale: Locale}) {
  const all = copy('legal-labels.shipping_glance') as unknown as Record<string, Glance> | undefined;
  const g = all?.[locale] ?? all?.en;
  if (!g?.rows?.length) return null;
  return (
    <dl aria-label={g.title} className="mb-8! grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[15px] [&>dd]:m-0! [&>dt]:m-0!">
      {g.rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--color-text-muted)]">{label}</dt>
          <dd className="font-mono text-[var(--color-text)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const meta: Route.MetaFunction = ({data}) => {
  const locale = data?.locale ?? 'en';
  const labels = legalLabels('shipping', locale);
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
  return resolveLegalLoader(request, 'shipping', 'shipping');
}

export default function ShippingRoute() {
  const {html, locale} = useLoaderData<typeof loader>();
  const labels = legalLabels('shipping', locale);
  // The back label is an optional field of the shipping labels only.
  const backLabel = (labels as {back?: string}).back;
  return (
    <LegalPage
      eyebrow={labels.eyebrow}
      title={labels.title}
      html={html}
      locale={locale}
      summary={<ShippingGlance locale={locale} />}
      // Buyers reach this page from the cart: it is help, not only terms.
      back={backLabel ? {to: '/support', label: backLabel} : undefined}
      className="legal-shipping"
    />
  );
}
