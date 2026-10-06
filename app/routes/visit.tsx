import type {Route} from './+types/visit';
import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EditorialShell} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {copy, copyText, editAttrs} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {VISIT_MAP} from '~/lib/visit-map.generated';

/**
 * The makerspace page: where Incutec works, the 3D walkthrough of the lab,
 * and when visitors can come in. Words live in `content/copy/visit.json`;
 * this file holds structure.
 *
 * The walkthrough is a static site under `public/lab-visit/` (its source and
 * tests are kept outside this repository), launched over the whole window.
 * Behind the page, instead of the brand watermark, is a map of the Vaartkom
 * (`scripts/gen-visit-map.py`, OpenStreetMap data) with the lab under the
 * open hours card.
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

const LAB_VISIT_SRC = '/lab-visit/index.html?launch=1&theme=dark';
const MAP_URL =
  'https://www.openstreetmap.org/search?query=Stapelhuisstraat%2015%2C%203000%20Leuven';
const AGENDA_URL = 'https://maakleerplek.be/nl/agenda';
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
/** Gap between the bottom of the hours card and the lab pin, in px. */
const PIN_GAP = 72;

/** Photo files in `public/makerspace/`, in the order of `visit.gallery_captions`. */
const PHOTOS = [
  'laser-cutter',
  'cnc',
  'workbench',
  'storage',
  'electronics',
  'printers',
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
 * The map tile and its pin. The map is drawn at one pixel per metre and
 * placed so the lab lands on `--pin-x` / `--pin-y`, which the caller sets:
 * the centre of the in-card map on phones, a point under the sticky card on
 * wide screens.
 */
function MapCanvas() {
  return (
    <>
      <div
        className="visit-map-canvas"
        style={
          {
            '--map-w': `${VISIT_MAP.width}px`,
            '--map-h': `${VISIT_MAP.height}px`,
            '--lab-x': `${VISIT_MAP.labX}px`,
            '--lab-y': `${VISIT_MAP.labY}px`,
          } as CSSProperties
        }
      />
      <div className="visit-map-pin" />
    </>
  );
}

/**
 * The page background on wide screens. Nothing here runs on scroll: the hours
 * card sticks at exactly the height it starts at, so it never moves while the
 * reader scrolls, and the map is a static fixed layer the browser composites
 * once. The card's sticky offset and the pin under it are measured on load
 * and on resize only.
 */
function VisitMapBackdrop() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const aside = document.querySelector<HTMLElement>('.editorial-aside');
      const card = document.querySelector<HTMLElement>('.visit-card--aside');
      if (!aside || !card || card.offsetParent === null) {
        el.style.removeProperty('--pin-x');
        el.style.removeProperty('--pin-y');
        return;
      }
      // Where the card sits with the page at the top, in document terms.
      aside.style.position = 'static';
      const naturalTop = aside.getBoundingClientRect().top + window.scrollY;
      aside.style.position = '';
      aside.style.top = `${Math.round(naturalTop)}px`;
      const r = card.getBoundingClientRect();
      const y = Math.min(
        naturalTop + r.height + PIN_GAP,
        window.innerHeight - 48,
      );
      el.style.setProperty('--pin-x', `${Math.round(r.left + r.width / 2)}px`);
      el.style.setProperty('--pin-y', `${Math.round(y)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('resize', schedule);
    // Fonts and the copy can change the card's height after first paint.
    const observer = new ResizeObserver(schedule);
    const card = document.querySelector('.visit-card--aside');
    if (card) observer.observe(card);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="visit-map" aria-hidden="true">
      <MapCanvas />
    </div>
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
      {placement === 'inline' ? (
        <div className="visit-card-map" aria-hidden="true">
          <MapCanvas />
        </div>
      ) : null}
      <address className="visit-address">
        <strong>maakleerplek, High Tech Lab</strong>
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
      <p className="visit-map-credit">
        <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noopener noreferrer">
          <Txt id="visit.map_attribution" />
        </a>
      </p>
    </section>
  );
}

/**
 * The walkthrough is a game, so it does not live in the article: the card
 * shows a still from the scan, and "Enter the lab" opens the game over the
 * whole window (browser full screen where the Fullscreen API exists, a fixed
 * overlay everywhere else, which is what iPhone Safari gets). Nothing is
 * downloaded until that click. The game posts `exit` from its pause menu and
 * `complete` from its end screen; both close the overlay, and `complete`
 * lands the visitor on the open hours.
 */
function LabLauncher() {
  const overlayRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [open, setOpen] = useState(false);

  function launch() {
    setOpen(true);
    // Must run inside the click: browsers only grant full screen to a gesture.
    const el = overlayRef.current;
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  function close(showHours = false) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setOpen(false);
    if (showHours) {
      const cards = document.querySelectorAll<HTMLElement>('.visit-card');
      Array.from(cards)
        .find((card) => card.offsetParent !== null)
        ?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }

  useEffect(() => {
    if (!open) return;
    function onMessage(e: MessageEvent) {
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as {source?: string; type?: string} | null;
      if (!data || data.source !== 'lab-visit') return;
      if (data.type === 'exit') close();
      if (data.type === 'complete') close(true);
    }
    window.addEventListener('message', onMessage);
    // The page behind the game must not scroll under touch input.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    frameRef.current?.focus();
    return () => {
      window.removeEventListener('message', onMessage);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <div className="visit-launch">
        <img
          className="visit-launch-poster"
          src="/makerspace/scan-poster.webp"
          alt=""
          width={1600}
          height={900}
        />
        <div className="visit-launch-body">
          <Txt id="visit.scan_kicker" as="p" className="visit-launch-kicker" />
          <Txt id="visit.scan_title" as="h2" className="visit-launch-title" />
          <Txt id="visit.scan_body" as="p" className="visit-launch-text" />
          <button
            type="button"
            className="visit-launch-button"
            onClick={launch}
          >
            <Txt id="visit.scan_cta" />
          </button>
          <Txt id="visit.scan_meta" as="p" className="visit-launch-meta" />
        </div>
      </div>
      <Txt id="visit.scan_note" as="p" className="visit-scan-meta" />

      <div
        ref={overlayRef}
        className={open ? 'visit-game is-open' : 'visit-game'}
        aria-hidden={!open}
      >
        {open ? (
          <>
            <iframe
              ref={frameRef}
              className="visit-game-frame"
              src={LAB_VISIT_SRC}
              title={copyText('visit.scan_title_attr') ?? 'Lab walkthrough'}
              allow="fullscreen"
            />
            <button
              type="button"
              className="visit-game-close"
              onClick={() => close()}
              aria-label={copyText('visit.scan_close') ?? 'Leave the lab'}
            >
              ×
            </button>
          </>
        ) : null}
      </div>
    </>
  );
}

export default function VisitRoute({loaderData}: Route.ComponentProps) {
  const captions = stringList('visit.gallery_captions');
  return (
    <EditorialShell
      slug="visit"
      backdrop={<VisitMapBackdrop />}
      aside={<HoursCard address={loaderData.address} placement="aside" />}
    >
      <header className="editorial-hero">
        <Txt id="visit.eyebrow" as="p" className="editorial-eyebrow" />
        <Txt id="visit.title" as="h1" className="editorial-title" />
        <Txt id="visit.lead" as="p" className="editorial-lead" />
      </header>

      <LabLauncher />

      <HoursCard address={loaderData.address} placement="inline" />

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
          href={MAP_URL}
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
