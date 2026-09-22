import {useLoaderData} from 'react-router';
import type {Route} from './+types/shipping';
import {LegalPage} from '~/components/LegalPage';
import {alternateLocaleTags, legalLabels, resolveLegalLoader, seoLocaleTag} from '~/lib/i18n';
import {buildSeoMeta} from '~/lib/seo';
import {copy} from '~/lib/copy';
import type {Locale} from '~/lib/i18n';

type Glance = {title: string; rate: string; paid: string; targets: string; duties: string};

/** The buyer's summary above the shipping terms: the rate, when each kind
 *  of product ships and who pays duties outside the EU. The terms below
 *  stay the text that applies. Words in content/copy/legal-labels.json. */
function ShippingGlance({locale}: {locale: Locale}) {
  const all = copy('legal-labels.shipping_glance') as unknown as Record<string, Glance> | undefined;
  const g = all?.[locale] ?? all?.en;
  if (!g) return null;
  return (
    <section
      aria-label={g.title}
      className="mb-8 rounded-[var(--r-md)] border border-[var(--color-border)] border-l-[3px] border-l-[var(--color-gold-fill)] bg-[var(--color-bg-card)] px-5! py-4! text-[15px] leading-relaxed"
    >
      <h2 className="mt-0! mb-2! font-display text-[17px] font-semibold text-[var(--color-text)]">{g.title}</h2>
      <ul className="m-0! flex list-none flex-col gap-1.5 p-0! text-[var(--color-text-muted)] [&>li]:m-0!">
        {[g.rate, g.paid, g.targets, g.duties].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
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
