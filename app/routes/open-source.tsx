import type {Route} from './+types/open-source';
import {Link} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {TeamStrip} from '~/components/TeamStrip';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {
  MarginArt,
  BranchMergeArt,
  PackagedBoardArt,
  FunnelArt,
  RecordTracesArt,
  UnboxArt,
  CopyleftCascadeArt,
  ForkVariantsArt,
} from '~/components/MarginArt';

/**
 * Every word on this page comes from `content/copy/open-source.json`, edited in
 * the studio. What stays in this file is structure: which sections exist, in
 * what order, and which margin drawing sits beside each one.
 *
 * That split is the whole point. Copy changes are a JSON edit with no code
 * review; layout changes are a code change with one.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('open-source.meta_title') ?? 'Open Source',
    description: copyText('open-source.meta_description') ?? '',
  });

export async function loader(_args: Route.LoaderArgs) {
  return {};
}

/** Section order and the drawing each one carries. Copy is keyed off `n`. */
const SECTIONS = [
  {n: 1, art: <BranchMergeArt />},
  {n: 2, art: <PackagedBoardArt />},
  {n: 3, art: <FunnelArt />},
  {n: 4, art: <RecordTracesArt />},
  {n: 5, art: <UnboxArt />},
  {n: 6, art: <CopyleftCascadeArt />},
];

export default function OpenSourceRoute() {
  return (
    <EditorialShell slug="open-source">
      <header className="editorial-hero">
        <Txt id="open-source.title" as="h1" className="editorial-title" />
        <Txt id="open-source.lead" as="p" className="editorial-lead" />
      </header>

      {SECTIONS.map(({n, art}) => (
        <section className="editorial-section" key={n}>
          <Txt
            id={`open-source.s${n}_title`}
            as="h2"
            className="editorial-section-title"
          />
          <MarginArt>{art}</MarginArt>
          <Txt id={`open-source.s${n}_body`} as="p" />
          {n === 2 ? <TeamStrip /> : null}
        </section>
      ))}

      <section className="editorial-section">
        <Txt
          id="open-source.s7_title"
          as="h2"
          className="editorial-section-title"
        />
        <MarginArt>
          <ForkVariantsArt />
        </MarginArt>
        <ul className="editorial-list">
          <Txt id="open-source.s7_list" as="li" />
        </ul>
      </section>

      <section className="editorial-section">
        <Txt
          id="open-source.s8_title"
          as="h2"
          className="editorial-section-title"
        />
        <Txt id="open-source.s8_body" as="p" />
      </section>

      <section className="editorial-cta">
        <Link prefetch="viewport" to="/roadmap" className="editorial-cta-primary">
          <Txt id="open-source.cta_primary" />
        </Link>
        <a
          href="https://github.com/OpenDrone-hw"
          target="_blank"
          rel="noopener noreferrer"
          className="editorial-cta-secondary"
        >
          <Txt id="open-source.cta_secondary" />
        </a>
      </section>
    </EditorialShell>
  );
}
