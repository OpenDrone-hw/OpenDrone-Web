import type {Route} from './+types/testing';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {getFigures, getTimeline} from '~/lib/testing-content';
import {TestingFigure} from '~/components/testing/TestingFigure';
import {TestingGroup} from '~/components/testing/TestingGroup';
import {TestingLog} from '~/components/testing/TestingLog';

/**
 * Measured data from the bench and the field. The numbers and their prose live
 * in `content/testing/*.json` (written by `npm run sync:testing`); the page's
 * own words live in `content/copy/testing.json`. Items marked needs-review in
 * the data never reach this page: the loader drops them.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('testing.meta_title') ?? 'Testing',
    description: copyText('testing.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/testing`,
  });

export async function loader(_args: Route.LoaderArgs) {
  return {};
}

const PRODUCTS: Array<{handle: string; key: string}> = [
  {handle: 'openesc', key: 'openesc'},
  {handle: 'openmotor', key: 'openmotor'},
  {handle: 'openrx', key: 'openrx'},
  {handle: 'openfc-lite', key: 'openfc_lite'},
  {handle: 'openframe', key: 'openframe'},
];

export default function TestingRoute() {
  return (
    <EditorialShell slug="testing" pageClassName="testing-page">
      <header className="editorial-hero">
        <Txt id="testing.hero_title" as="h1" className="editorial-title" />
        <Txt id="testing.hero_body" as="p" className="editorial-lead" />
      </header>

      {PRODUCTS.map(({handle, key}) => {
        const figures = getFigures(handle);
        const solo = figures.filter((f) => !f.group).slice(0, 3);
        const groups = [...new Set(figures.filter((f) => f.group).map((f) => f.group!))];
        const log = getTimeline(handle);
        return (
          <section className="editorial-section testing-section" id={handle} key={handle}>
            <Txt id={`testing.section_${key}`} as="h2" className="editorial-section-title" />
            {figures.length === 0 ? (
              <Txt id={`testing.empty_${key}`} as="p" />
            ) : (
              <>
                <Txt id={`testing.tested_${key}`} as="p" className="testing-tested" />
                {solo.map((f) => (
                  <TestingFigure key={f.id} figure={f} />
                ))}
                {groups.map((g) => (
                  <TestingGroup key={g} figures={figures.filter((f) => f.group === g)} />
                ))}
                {handle === 'openfc-lite' ? (
                  <Txt id="testing.empty_fc_bench" as="p" className="testing-note" />
                ) : null}
                {handle === 'openmotor' ? (
                  <Txt id="testing.note_uncalibrated" as="p" className="testing-note" />
                ) : null}
              </>
            )}
            {log.length > 0 ? (
              <>
                <Txt id="testing.log_title" as="h3" className="testing-log-title" />
                <TestingLog items={log} />
              </>
            ) : null}
          </section>
        );
      })}
    </EditorialShell>
  );
}
