import type {Route} from './+types/visit';
import {useEffect, useRef, useState} from 'react';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {copy, copyText, editAttrs} from '~/lib/copy';
import {DISCORD_INVITE_URL, getCompanyIdentity} from '~/lib/company';

/**
 * The makerspace page: where Incutec works, the 3D walkthrough of the lab,
 * and when visitors can come in. Words live in `content/copy/visit.json`;
 * this file holds structure.
 *
 * The walkthrough is a static site under `public/lab-visit/` (its source and
 * tests are kept outside this repository). The frame loads its small shell
 * lazily and downloads the 35 MB scan only after the visitor presses start
 * inside it, so the page itself stays light.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('visit.meta_title') ?? 'Visit',
    description: copyText('visit.meta_description') ?? '',
    canonical: `${SITE_ORIGIN}/visit`,
  });

export async function loader({context}: Route.LoaderArgs) {
  return {
    address: getCompanyIdentity(
      context.env as unknown as Record<string, string | undefined>,
    ).address,
  };
}

const LAB_VISIT_SRC = '/lab-visit/index.html?embed=1&theme=dark';
const MAP_URL =
  'https://www.openstreetmap.org/search?query=Stapelhuisstraat%2015%2C%203000%20Leuven';
const AGENDA_URL = 'https://maakleerplek.be/nl/agenda';

/** Photo files in `public/makerspace/`, in the order of `visit.gallery_captions`. */
const PHOTOS = [
  'printers',
  'printer-cabinet',
  'laser-cutter',
  'workbench',
  'storage',
  'electronics-desk',
];

function stringList(id: string): string[] {
  const value = copy(id);
  return Array.isArray(value) ? value : [];
}

/** `visit.hours_rows` entries are `day|time|what`. */
function HoursTable() {
  const rows = stringList('visit.hours_rows')
    .map((row) => row.split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length === 3);
  return (
    <table className="visit-hours" {...editAttrs('visit.hours_rows')}>
      <tbody>
        {rows.map(([day, time, what]) => (
          <tr key={`${day}-${time}`}>
            <th scope="row">
              {day}
              <span className="visit-hours-what">{what}</span>
            </th>
            <td className="visit-hours-time">{time}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Rendered twice: as the sticky side card on wide screens, and right after
 * the intro on narrow ones, where the shell would otherwise stack the aside
 * below the whole article. CSS shows exactly one of the two.
 */
function HoursCard({
  address,
  placement,
}: {
  address: string;
  placement: 'aside' | 'inline';
}) {
  const titleId = `visit-hours-${placement}`;
  return (
    <section
      className={`visit-card visit-card--${placement}`}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="editorial-section-title">
        <Txt id="visit.hours_title" />
      </h2>
      <HoursTable />
      <Txt id="visit.hours_note" as="p" className="visit-card-note" />
      <address className="visit-address">
        <strong>Maakleerplek, HighTechLab</strong>
        <br />
        {address}
      </address>
      <a
        href={MAP_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="visit-card-link"
      >
        <Txt id="visit.where_map" />
      </a>
    </section>
  );
}

function LabVisitFrame() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [maximised, setMaximised] = useState(false);

  // Safari on iPhone has no Fullscreen API inside a frame, so the walkthrough
  // asks the page to enlarge it instead. On completion it offers the visit
  // details, which live further down this page.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as {source?: string; type?: string} | null;
      if (!data || data.source !== 'lab-visit') return;
      if (data.type === 'fullscreen-request') setMaximised((m) => !m);
      if (data.type === 'complete') {
        setMaximised(false);
        const cards = document.querySelectorAll<HTMLElement>('.visit-card');
        Array.from(cards)
          .find((card) => card.offsetParent !== null)
          ?.scrollIntoView({behavior: 'smooth', block: 'start'});
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={frameRef}
      className={maximised ? 'visit-scan visit-scan--max' : 'visit-scan'}
      src={LAB_VISIT_SRC}
      title={copyText('visit.scan_title_attr') ?? 'Lab walkthrough'}
      allow="fullscreen"
      loading="lazy"
    />
  );
}

export default function VisitRoute({loaderData}: Route.ComponentProps) {
  const captions = stringList('visit.gallery_captions');
  return (
    <EditorialShell
      slug="visit"
      aside={<HoursCard address={loaderData.address} placement="aside" />}
    >
      <header className="editorial-hero">
        <Txt id="visit.eyebrow" as="p" className="editorial-eyebrow" />
        <Txt id="visit.title" as="h1" className="editorial-title" />
        <Txt id="visit.lead" as="p" className="editorial-lead" />
      </header>

      <HoursCard address={loaderData.address} placement="inline" />

      <section className="editorial-section">
        <Txt
          id="visit.scan_title"
          as="h2"
          className="editorial-section-title"
        />
        <Txt id="visit.scan_body" as="p" />
        <LabVisitFrame />
        <p className="visit-scan-meta">
          <Txt id="visit.scan_note" />{' '}
          <a href="/lab-visit/index.html" target="_blank" rel="noopener">
            <Txt id="visit.scan_fullscreen" />
          </a>
        </p>
      </section>

      <section className="editorial-section">
        <Txt id="visit.s1_title" as="h2" className="editorial-section-title" />
        <Txt id="visit.s1_body" as="p" />
      </section>

      <section className="editorial-section">
        <Txt id="visit.s2_title" as="h2" className="editorial-section-title" />
        <Txt id="visit.s2_body" as="p" />
      </section>

      <section className="editorial-section">
        <Txt
          id="visit.gallery_title"
          as="h2"
          className="editorial-section-title"
        />
        <div className="visit-gallery" {...editAttrs('visit.gallery_captions')}>
          {PHOTOS.map((name, i) => (
            <figure key={name}>
              <img
                src={`/makerspace/${name}.webp`}
                alt={captions[i] ?? ''}
                width={1600}
                height={1200}
                loading="lazy"
                decoding="async"
              />
              <figcaption>{captions[i]}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="editorial-section">
        <Txt
          id="visit.youngmakerlab_title"
          as="h2"
          className="editorial-section-title"
        />
        <Txt id="visit.youngmakerlab_body" as="p" />
      </section>

      <section className="editorial-section">
        <Txt
          id="visit.where_title"
          as="h2"
          className="editorial-section-title"
        />
        <Txt id="visit.where_body" as="p" />
      </section>

      <section className="editorial-cta">
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="editorial-cta-primary"
        >
          <Txt id="visit.cta_primary" />
        </a>
        <a
          href={AGENDA_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="editorial-cta-secondary"
        >
          <Txt id="visit.cta_secondary" />
        </a>
      </section>
    </EditorialShell>
  );
}
