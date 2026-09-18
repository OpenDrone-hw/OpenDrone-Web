import type {Route} from './+types/preorder';
import {Link} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * The preorder explainer: why a product has a funding target at all, what
 * happens when it is reached, and what happens when it is missed. Every
 * preorder product links here, so this page is the one place the refund
 * guarantee and the one-delivery rule are stated in full.
 *
 * Same split as the production page: words in `content/copy/preorder.json`,
 * section order here. A copy edit is a JSON change.
 *
 * `rail={false}` and no entry in EDITORIAL_SERIES: the series is a reading
 * sequence about the project, and a page a buyer is sent to from a product
 * page is not a chapter of it. It is reachable from the footer, the sitemap
 * and every preorder product.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('preorder.meta_title') ?? 'Preorders',
    description: copyText('preorder.meta_description') ?? '',
  });

export async function loader(_args: Route.LoaderArgs) {
  return {};
}

const SECTIONS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;

export default function PreorderRoute() {
  return (
    <EditorialShell slug="preorder" rail={false}>
      <header className="editorial-hero">
        <Txt id="preorder.title" as="h1" className="editorial-title" />
        <Txt id="preorder.lead" as="p" className="editorial-lead" />
      </header>

      {SECTIONS.map((s) => (
        <section className="editorial-section" key={s}>
          <Txt
            id={`preorder.${s}_title`}
            as="h2"
            className="editorial-section-title"
          />
          <Txt id={`preorder.${s}_body`} as="p" />
        </section>
      ))}

      <section className="editorial-cta">
        <Link
          prefetch="viewport"
          to="/products"
          className="editorial-cta-primary"
        >
          <Txt id="preorder.cta_primary" />
        </Link>
        <Link
          prefetch="viewport"
          to="/production"
          className="editorial-cta-secondary"
        >
          <Txt id="preorder.cta_secondary" />
        </Link>
      </section>
    </EditorialShell>
  );
}
