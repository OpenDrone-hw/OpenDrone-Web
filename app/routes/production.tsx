import type {Route} from './+types/production';
import {Link} from 'react-router';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {ProductionLadder} from '~/components/ProductionLadder';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * Words live in `content/copy/production.json`; this file holds the section
 * order and the ladder that sits beside them. Same split as the open source
 * page: a copy edit is a JSON change, a layout change is a code change.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('production.meta_title') ?? 'Production',
    description: copyText('production.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/production`,
  });

export async function loader(_args: Route.LoaderArgs) {
  return {};
}

export default function ProductionRoute() {
  return (
    <EditorialShell slug="production" aside={<ProductionLadder />}>
      <header className="editorial-hero">
        <Txt id="production.title" as="h1" className="editorial-title" />
        <Txt id="production.lead" as="p" className="editorial-lead" />
      </header>

      {/* Section 01 (designed in the open) was cut by the maintainer in the studio
          (2026-08-11); the open-source page carries that story. */}
      <section className="editorial-section">
        <Txt
          id="production.s2_title"
          as="h2"
          className="editorial-section-title"
        />
        <Txt id="production.s2_body" as="p" />
      </section>

      <section className="editorial-section">
        <Txt
          id="production.s3_title"
          as="h2"
          className="editorial-section-title"
        />
        <Txt id="production.s3_body" as="p" />
      </section>

      <section className="editorial-section">
        <Txt id="roadmap.goals_title" as="h2" className="editorial-section-title" />
        <Txt id="roadmap.goals_body" as="p" />
      </section>

      <section className="editorial-cta">
        <Link
          prefetch="viewport"
          to="/open-source"
          className="editorial-cta-primary"
        >
          <Txt id="production.cta_primary" />
        </Link>
        <Link prefetch="viewport" to="/roadmap" className="editorial-cta-secondary">
          <Txt id="production.cta_secondary" />
        </Link>
      </section>
    </EditorialShell>
  );
}
