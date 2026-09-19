import type {Route} from './+types/firmware-partners';
import {Link} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {FIRMWARE_PARTNERS} from '~/lib/firmware-partners';

/**
 * Every word on this page comes from `content/copy/firmware-partners.json`,
 * edited in the studio. What stays here is structure: the sections, the partner
 * cards' order, and the URLs each card points at.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('firmware-partners.meta_title') ?? 'Firmware partners',
    description: copyText('firmware-partners.meta_description') ?? '',
  });

export async function loader(_args: Route.LoaderArgs) {
  return {};
}

type MergedPr = {
  project: string; // upstream project name
  title: string; // the PR title as it reads on GitHub
  url: string; // the real PR URL - must resolve
  what: string; // one line: what the change does for users
};

/**
 * Upstream contributions with receipts. HARD RULE: only list PRs that are
 * real, authored by us, and MERGED on the upstream repo - verify the URL
 * before adding an entry. Never list aspirational or in-progress work here.
 *
 * Verified 2026-07-06 (gh pr list --author Just4Stan on betaflight/betaflight,
 * am32-firmware/AM32, ExpressLRS/ExpressLRS + a global PR search): zero
 * merged and zero open upstream PRs so far. The Betaflight RP2350-platform
 * work lives on our fork and hasn't been submitted upstream yet. The section
 * below stays hidden until this array gains its first verified entry.
 *
 * Receipts, not prose: these stay in code so a copy edit can never invent one.
 */
const MERGED_PRS: MergedPr[] = [];

// Card order and the links each one carries live in the shared lib, so the
// PDP firmware chapter and this page can never disagree on a URL. Copy is
// keyed off each partner's `id`.
const PARTNERS = FIRMWARE_PARTNERS;

export default function FirmwarePartnersRoute() {
  return (
    <EditorialShell slug="firmware-partners">
      <header className="editorial-hero">
        <Txt
          id="firmware-partners.title"
          as="h1"
          className="editorial-title"
        />
        <Txt id="firmware-partners.lead" as="p" className="editorial-lead" />
      </header>

      <section className="editorial-section">
        <Txt
          id="firmware-partners.s2_title"
          as="h2"
          className="editorial-section-title"
        />
        <div className="partners-grid">
          {PARTNERS.map((p) => (
            <article key={p.id} className="partner-card">
              <span
                className="partner-card-logo"
                style={{
                  WebkitMaskImage: `url(/logos/${p.id}.svg)`,
                  maskImage: `url(/logos/${p.id}.svg)`,
                  ['--logo-ratio' as string]:
                    p.id === 'betaflight' ? '4.2' : '2.6',
                }}
                aria-hidden="true"
              />
              <Txt
                id={`firmware-partners.partner_${p.id}_label`}
                as="p"
                className="partner-label"
              />
              <Txt
                id={`firmware-partners.partner_${p.id}_project`}
                as="h3"
                className="partner-project"
              />
              <Txt
                id={`firmware-partners.partner_${p.id}_blurb`}
                as="p"
                className="partner-blurb"
              />
              <div className="partner-links">
                <a
                  href={p.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Txt id="firmware-partners.partner_link_source" />
                </a>
                {p.donationUrl ? (
                  <a
                    href={p.donationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Txt id="firmware-partners.partner_link_donate" />
                  </a>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      {MERGED_PRS.length > 0 ? (
        <section className="editorial-section">
          <Txt
            id="firmware-partners.s4_title"
            as="h2"
            className="editorial-section-title"
          />
          <Txt id="firmware-partners.s4_body" as="p" />
          <ul className="upstream-list">
            {MERGED_PRS.map((pr) => (
              <li className="upstream-item" key={pr.url}>
                <p className="upstream-project">{pr.project}</p>
                <a
                  className="upstream-title"
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {pr.title} ↗
                </a>
                <p className="upstream-what">{pr.what}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="editorial-cta">
        <Link prefetch="viewport" to="/open-source" className="editorial-cta-primary">
          <Txt id="firmware-partners.cta_primary" />
        </Link>
        <Link prefetch="viewport" to="/collections/all" className="editorial-cta-secondary">
          <Txt id="firmware-partners.cta_secondary" />
        </Link>
      </section>
    </EditorialShell>
  );
}
