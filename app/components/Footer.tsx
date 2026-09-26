import {NavLink} from '~/components/nav';
import {
  DISCORD_INVITE_URL,
  CONTRIBUTING_URL,
  type CompanyIdentity,
} from '~/lib/company';
import {NewsletterSignup} from '~/components/NewsletterSignup';
import {Txt} from '~/components/Txt';
import {SiteWordmark} from '~/components/SiteWordmark';
import {
  LegalLanguages,
  legalHref,
  useLegalLocale,
} from '~/components/LangToggle';
import {useEffect, useRef, useState} from 'react';

interface FooterProps {
  company: CompanyIdentity;
  turnstileSiteKey?: string | null;
}

/**
 * The link lists are structure: which link exists, in what order, and where it
 * points. Only the visible label is data - `copy` names its key in
 * `content/copy/chrome.json`, so the same label can be shared with the header
 * (Newsletter, Contact, All Products, GitHub) and the maintainer edits it once.
 */
const SHOP_LINKS: Array<{to: string; copy: string}> = [
  {to: '/products', copy: 'nav_all_products'},
  {to: '/preorder', copy: 'nav_preorder'},
  {to: '/newsletter', copy: 'nav_newsletter'},
  {to: '/wholesale', copy: 'nav_trade'},
];

/**
 * The community column: every place OpenDrone and Incutec are present, one
 * link each. Per-repo links were removed on the maintainer's call (2026-08-11): the
 * GitHub org covers them, and the site-source link lives in the bottom bar.
 * Add new socials here as accounts go live; the label is a chrome.json key.
 */
const SOCIAL_LINKS: Array<{href: string; copy: string}> = [
  {href: DISCORD_INVITE_URL, copy: 'nav_discord'},
  {href: 'https://github.com/OpenDrone-hw', copy: 'nav_github'},
  {href: CONTRIBUTING_URL, copy: 'nav_contributing'},
];

/**
 * Customer service: the pages a buyer looks for before and after an order,
 * in the order shops usually list them. Support opens a ticket; "Find my
 * ticket" brings back an earlier one. Email is for sales only (/support#sales).
 */
const HELP_LINKS: Array<{to: string; copy: string}> = [
  {to: '/support', copy: 'nav_support'},
  {to: '/shipping', copy: 'nav_shipping'},
  {to: '/herroepingsrecht', copy: 'nav_returns'},
  {to: '/warranty', copy: 'nav_warranty'},
  {to: '/support/find', copy: 'nav_find_ticket'},
];

const COMPANY_LINKS: Array<{to: string; copy: string}> = [
  {to: '/open-source', copy: 'nav_open_source_incutec'},
  {to: '/firmware-partners', copy: 'nav_firmware_partners'},
  {to: '/roadmap', copy: 'nav_roadmap'},
  {to: '/timeline', copy: 'nav_timeline'},
  {to: '/production', copy: 'nav_production'},
];

// The imprint heads the Legal column; shipping, returns and warranty sit in
// Customer service above, and the withdrawal link stays here too because the
// law expects it to be easy to find.
const LEGAL_LINKS: Array<{to: string; copy: string}> = [
  {to: '/legal', copy: 'nav_legal_imprint'},
  {to: '/algemene-voorwaarden', copy: 'nav_terms'},
  {to: '/privacy', copy: 'nav_privacy'},
  {to: '/cookies', copy: 'nav_cookies'},
  {to: '/herroepingsrecht#withdraw', copy: 'nav_withdrawal'},
  {to: '/end-use', copy: 'nav_end_use'},
  {to: '/recycling', copy: 'nav_recycling'},
  {to: '/security', copy: 'nav_security'},
  {to: '/cookie-settings', copy: 'nav_cookie_settings'},
];

function ColumnHeading({id}: {id: string}) {
  return (
    <Txt
      id={id}
      as="h4"
      className="font-mono text-[12px] uppercase tracking-[0.2em] text-[var(--color-text-muted)] mb-3"
    />
  );
}

/**
 * One link group. Below 640px it is a collapsed <details> with the heading
 * as its summary, so the phone footer is a short list of headings instead
 * of five full columns; `open` groups (Shop, Customer service) stay open.
 * The server renders every group open, so the links are there without
 * JavaScript and on desktop, where the summary is a plain heading.
 */
function FooterGroup({
  id,
  open = false,
  children,
}: {
  id: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia('(max-width: 639px)');
    const apply = () => {
      el.open = mq.matches ? open : true;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [open]);
  return (
    <details ref={ref} open className="group/fg">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between sm:min-h-0 sm:cursor-default sm:pointer-events-none [&::-webkit-details-marker]:hidden">
        <ColumnHeading id={id} />
        {/* One chevron, turned over when the group is open. */}
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="mb-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/fg:rotate-180 sm:hidden"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      {children}
    </details>
  );
}

/** A reference designator in front of a link: every link is a connector. */
function RefTag({n}: {n?: number}) {
  return n ? (
    <span className="footer-ref" aria-hidden="true">
      J{n}
    </span>
  ) : null;
}

function FooterNavLink({
  to,
  refNo,
  children,
}: {
  to: string;
  refNo?: number;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      end
      prefetch="intent"
      to={to}
      className={({isActive}) =>
        `footer-link text-xs transition-colors flex items-center min-h-[36px] md:min-h-0 ${
          isActive
            ? 'text-[var(--color-text)]'
            : 'text-[var(--color-text-muted)]'
        }`
      }
    >
      <RefTag n={refNo} />
      {children}
    </NavLink>
  );
}

// Zone marks along the drawing frame, as on a KiCad sheet border.
const ZONE_COLUMNS = ['1', '2', '3', '4', '5', '6'];
const ZONE_ROWS = ['A', 'B', 'C', 'D'];

function ZoneRulers() {
  return (
    <div className="footer-zones" aria-hidden="true">
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <span key={c} className={`footer-corner footer-corner--${c}`} />
      ))}
      {(['top', 'bottom'] as const).map((edge) => (
        <div key={edge} className={`footer-zone-row footer-zone-row--${edge}`}>
          {ZONE_COLUMNS.map((z) => (
            <span key={z}>{z}</span>
          ))}
        </div>
      ))}
      {(['left', 'right'] as const).map((edge) => (
        <div key={edge} className={`footer-zone-col footer-zone-col--${edge}`}>
          {ZONE_ROWS.map((z) => (
            <span key={z}>{z}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

// The drawing view: the OpenFC Lite outline from its board export (the
// clip path of the lighter layered SVG), with its width dimensioned. Fetched
// once the footer nears the viewport; it is decoration and renders nothing
// until then or if the fetch fails.
const VIEW_BOARD = '/boards/openfc-lite/board-lite.svg';

type Outline = {x: number; y: number; w: number; h: number; d: string};

function DrawingView() {
  const ref = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        fetch(VIEW_BOARD)
          .then((r) => (r.ok ? r.text() : ''))
          .then((svg) => {
            const box = svg
              .match(/viewBox="([^"]+)"/)?.[1]
              .split(/\s+/)
              .map(Number);
            const d = svg.match(/<clipPath[^>]*>\s*<path d="([^"]+)"/)?.[1];
            if (cancelled || !d || !box || box.length !== 4) return;
            const [x, y, w, h] = box;
            setOutline({x, y, w, h, d});
          })
          .catch(() => {});
      },
      {rootMargin: '400px 0px'},
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, []);
  const o = outline;
  // Margins around the board for the dimension line and its text.
  const pad = o ? o.w * 0.18 : 0;
  return (
    <div ref={ref} className="footer-view" aria-hidden="true">
      {o ? (
        <svg
          viewBox={`${o.x - pad} ${o.y - pad} ${o.w + pad * 2} ${o.h + pad * 2.4}`}
          focusable="false"
        >
          <path
            d={o.d}
            className="footer-view-outline"
            vectorEffect="non-scaling-stroke"
          />
          {/* Centre marks. */}
          <path
            d={`M ${o.x + o.w / 2 - 3} ${o.y + o.h / 2} h 6 M ${o.x + o.w / 2} ${o.y + o.h / 2 - 3} v 6`}
            className="footer-view-dim"
            vectorEffect="non-scaling-stroke"
          />
          {/* Width dimension under the board. */}
          <path
            d={`M ${o.x} ${o.y + o.h + pad * 0.25} v ${pad * 0.7} M ${o.x + o.w} ${o.y + o.h + pad * 0.25} v ${pad * 0.7} M ${o.x} ${o.y + o.h + pad * 0.75} H ${o.x + o.w}`}
            className="footer-view-dim"
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={o.x + o.w / 2}
            y={o.y + o.h + pad * 1.35}
            textAnchor="middle"
            className="footer-view-text"
            style={{fontSize: o.w * 0.06}}
          >
            {o.w.toFixed(1)}
          </text>
        </svg>
      ) : null}
      <Txt id="chrome.footer_view_label" as="p" className="footer-view-label" />
    </div>
  );
}

/** One row of the title block. */
function TitleCell({
  label,
  children,
  span,
}: {
  label: string;
  children: React.ReactNode;
  /** Width in twelfths of the block. */
  span: 2 | 3 | 4 | 6 | 12;
}) {
  return (
    <div
      className={`footer-tb-cell footer-tb-s${span}`}
      data-cell={label.replace(/^chrome\.footer_(tb_)?/, '')}
    >
      <Txt id={label} as="dt" className="footer-tb-label" />
      <dd className="footer-tb-value">{children}</dd>
    </div>
  );
}

// Build stamp (vite.config.ts `define`); absent when the module runs outside
// Vite, e.g. under node:test.
const BUILD_REV = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : '';
const BUILD_DATE = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';

export function Footer({company, turnstileSiteKey}: FooterProps) {
  const legalLocale = useLegalLocale();
  // Reference designators run across the whole parts list, J1 to Jn.
  let refNo = 0;
  const nextRef = () => ++refNo;
  return (
    <footer className="mt-auto">
      <div className="site-footer-inner">
        <div className="footer-drawing">
          <ZoneRulers />
          <div className="footer-sheet">
            <div className="footer-top">
              <div className="footer-notes">
                <Txt
                  id="chrome.footer_notes"
                  as="h3"
                  className="footer-sheet-heading"
                />
                <ol className="footer-notes-list">
                  <li className="footer-note">
                    <p>
                      <Txt id="chrome.footer_run_by" /> {company.name}.{' '}
                      <NavLink
                        to="/open-source"
                        prefetch="intent"
                        className="underline underline-offset-2 hover:text-[var(--color-gold-text)]"
                      >
                        <Txt id="chrome.incutec_hint" />
                      </NavLink>
                    </p>
                  </li>
                </ol>
              </div>
              {/* DETAIL A: the newsletter, its own bounded cell. The form
                  keeps its markup, consent checkbox and behaviour; consent
                  lives on the Shopify customer and this form is anonymous,
                  so every visitor sees the same form. */}
              <div className="footer-detail footer-note--newsletter">
                <Txt
                  id="chrome.footer_detail_newsletter"
                  as="span"
                  className="footer-detail-label"
                />
                <NewsletterSignup
                  variant="footer"
                  turnstileSiteKey={turnstileSiteKey ?? null}
                />
              </div>
            </div>

            {/* PARTS LIST: every link group, complete. */}
            <div className="footer-parts">
              <Txt
                id="chrome.footer_parts_list"
                as="h3"
                className="footer-sheet-heading"
              />
              <div className="footer-parts-grid">
                <FooterGroup id="chrome.heading_shop" open>
                  <nav className="flex flex-col gap-1.5">
                    {SHOP_LINKS.map((link) => (
                      <FooterNavLink
                        key={link.to}
                        to={link.to}
                        refNo={nextRef()}
                      >
                        <Txt id={`chrome.${link.copy}`} />
                      </FooterNavLink>
                    ))}
                  </nav>
                </FooterGroup>

                <FooterGroup id="chrome.heading_help" open>
                  <nav className="flex flex-col gap-1.5">
                    {HELP_LINKS.map((link) => (
                      <FooterNavLink
                        key={link.to}
                        to={legalHref(link.to, legalLocale)}
                        refNo={nextRef()}
                      >
                        <Txt id={`chrome.${link.copy}`} />
                      </FooterNavLink>
                    ))}
                  </nav>
                </FooterGroup>

                <FooterGroup id="chrome.heading_open_source">
                  <nav className="flex flex-col gap-1.5">
                    {SOCIAL_LINKS.map((link) => (
                      <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="footer-link text-xs text-[var(--color-text-muted)] transition-colors flex items-center min-h-[36px] md:min-h-0"
                      >
                        <RefTag n={nextRef()} />
                        <Txt id={`chrome.${link.copy}`} />
                      </a>
                    ))}
                  </nav>
                </FooterGroup>

                <FooterGroup id="chrome.heading_company">
                  <nav className="flex flex-col gap-1.5">
                    {COMPANY_LINKS.map((link) => (
                      <FooterNavLink
                        key={link.to}
                        to={link.to}
                        refNo={nextRef()}
                      >
                        <Txt id={`chrome.${link.copy}`} />
                      </FooterNavLink>
                    ))}
                  </nav>
                </FooterGroup>

                <div>
                  <FooterGroup id="chrome.heading_legal">
                    <nav className="footer-legal-nav flex flex-col gap-1.5">
                      {LEGAL_LINKS.map((link) => (
                        <FooterNavLink
                          key={link.to}
                          to={legalHref(link.to, legalLocale)}
                          refNo={nextRef()}
                        >
                          <Txt id={`chrome.${link.copy}`} />
                        </FooterNavLink>
                      ))}
                    </nav>
                  </FooterGroup>
                  {/* Phone: the Legal group folds, so the withdrawal link also
                      stands outside it and is always one tap away. */}
                  <div className="mt-2 sm:hidden">
                    <FooterNavLink
                      to={legalHref('/herroepingsrecht#withdraw', legalLocale)}
                    >
                      <Txt id="chrome.nav_withdrawal" />
                    </FooterNavLink>
                  </div>
                </div>
              </div>
            </div>

            {/* The sheet foot: the drawing view, languages and copyright on the left, the
                title block with the seller's legal identity on the right.
                Year and legal entity stay in code: one is the clock, the
                other is the identity in `company.ts` that also feeds the
                JSON-LD. */}
            <div className="footer-foot">
              <div className="footer-foot-left">
                <DrawingView />
                <div className="footer-foot-meta">
                  <LegalLanguages className="footer-small text-[var(--color-text-muted)]" />
                  <p className="footer-copyright">
                    &copy; {new Date().getFullYear()} {company.name}
                  </p>
                </div>
              </div>
              <dl className="footer-tb">
                <TitleCell label="chrome.footer_tb_title" span={3}>
                  <SiteWordmark className="footer-tb-wordmark" />
                </TitleCell>
                <TitleCell label="chrome.footer_tb_company" span={3}>
                  {company.name}
                </TitleCell>
                <TitleCell label="chrome.footer_tb_address" span={6}>
                  {company.address}
                </TitleCell>
                <TitleCell label="chrome.footer_tb_kbo" span={3}>
                  <span className="tabular-nums">{company.kbo}</span>
                </TitleCell>
                <TitleCell label="chrome.footer_tb_vat" span={3}>
                  <span className="tabular-nums">{company.vat}</span>
                </TitleCell>
                {company.email ? (
                  <TitleCell label="chrome.footer_email_label" span={6}>
                    <a href={`mailto:${company.email}`}>{company.email}</a>
                  </TitleCell>
                ) : null}
                {company.tel && company.tel !== '[pending]' ? (
                  <TitleCell label="chrome.footer_tb_tel" span={12}>
                    {company.tel}
                  </TitleCell>
                ) : null}
                <TitleCell label="chrome.footer_tb_licence" span={6}>
                  <Txt id="chrome.footer_licence_line" />{' '}
                  <Txt id="chrome.footer_site_source_line" />
                </TitleCell>
                {BUILD_REV ? (
                  <TitleCell label="chrome.footer_tb_rev" span={2}>
                    <a
                      href={`https://github.com/OpenDrone-hw/OpenDrone-Web/commit/${BUILD_REV}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {BUILD_REV}
                    </a>
                  </TitleCell>
                ) : null}
                <TitleCell
                  label="chrome.footer_tb_sheet"
                  span={
                    BUILD_REV && BUILD_DATE
                      ? 2
                      : BUILD_REV || BUILD_DATE
                        ? 3
                        : 6
                  }
                >
                  1 / 1
                </TitleCell>
                {BUILD_DATE ? (
                  <TitleCell
                    label="chrome.footer_tb_date"
                    span={BUILD_REV ? 2 : 3}
                  >
                    <span className="tabular-nums">{BUILD_DATE}</span>
                  </TitleCell>
                ) : null}
              </dl>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
