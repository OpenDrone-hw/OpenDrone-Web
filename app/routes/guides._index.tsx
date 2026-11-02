import {Link} from 'react-router';
import type {Route} from './+types/guides._index';
import {buildBreadcrumbJsonLd, buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {GUIDE_FAMILIES, guidePath, jsonLd} from '~/lib/guides';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * /guides - index of the beginner firmware guides. Content lives in
 * `app/lib/guides.ts`; the page chrome strings in `content/copy/guides.json`.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('guides.meta_title') ?? 'Firmware guides',
    description:
      copyText('guides.meta_description') ??
      'Step-by-step guides for updating the firmware on OpenDrone boards.',
    type: 'article',
    canonical: `${SITE_ORIGIN}/guides`,
  });

export async function loader(_args: Route.LoaderArgs) {
  return {};
}

export default function GuidesIndex() {
  return (
    <article className="page-shell">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: jsonLd(
            buildBreadcrumbJsonLd([
              {name: 'OpenDrone', path: '/'},
              {name: copyText('guides.title') ?? 'Firmware guides', path: '/guides'},
            ]),
          ),
        }}
      />
      <div className="reading-column">
        <header className="page-header">
          <Txt id="guides.eyebrow" as="p" className="page-eyebrow" fallback="Guides" />
          <Txt id="guides.title" as="h1" className="page-title" fallback="Firmware guides" />
        </header>
        <div className="rich-content">
          <Txt id="guides.lead" as="p" className="page-description" />

          <section>
            <Txt
              id="guides.safety_heading"
              as="h2"
              className="mt-8 text-[22px]"
              fallback="Before you start, every time"
            />
            <ul className="list-disc">
              <Txt id="guides.safety_points" as="li" />
            </ul>
          </section>

          <section>
            <Txt id="guides.browser_heading" as="h2" className="mt-8 text-[22px]" fallback="What you need" />
            <ul className="list-disc">
              <Txt id="guides.browser_points" as="li" />
            </ul>
          </section>

          {GUIDE_FAMILIES.map((family) => (
            <section key={family.id} className="mt-10">
              <h2 className="text-[22px]">
                {family.board}: {family.firmware}
              </h2>
              <p className="text-[var(--color-text-muted)]">{family.blurb}</p>
              <ol className="list-decimal">
                {family.pages.map((p) => (
                  <li key={p.slug}>
                    <Link prefetch="intent" to={guidePath(family.id, p.slug)}>
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          <section className="mt-10">
            <Txt id="guides.flash_cta_note" as="p" />
            {/* Full document load: /flash's USB/serial Permissions-Policy only
                applies to a freshly loaded document. */}
            <a href="/flash" className="btn-primary btn-sm mt-3 inline-block">
              {copyText('guides.flash_cta') ?? 'Open the firmware page'}
            </a>
          </section>
        </div>
      </div>
    </article>
  );
}
