import {NavLink} from '~/components/nav';
import {DISCORD_INVITE_URL, CONTRIBUTING_URL, type CompanyIdentity} from '~/lib/company';
import {CompanyFooterBlock} from '~/components/CompanyFooterBlock';
import {NewsletterSignup} from '~/components/NewsletterSignup';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

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
  {to: '/newsletter', copy: 'nav_newsletter'},
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

const COMPANY_LINKS: Array<{to: string; copy: string}> = [
  {to: '/open-source', copy: 'nav_open_source_incutec'},
  {to: '/firmware-partners', copy: 'nav_firmware_partners'},
  {to: '/roadmap', copy: 'nav_roadmap'},
  {to: '/timeline', copy: 'nav_timeline'},
  {to: '/production', copy: 'nav_production'},
];

// Imprint, contact and security head the Legal column (maintainer, 2026-08-12):
// they are practical/legal reader destinations, not part of the company story.
const LEGAL_LINKS: Array<{to: string; copy: string}> = [
  {to: '/legal', copy: 'nav_legal_imprint'},
  {to: '/support', copy: 'nav_contact'},
  {to: '/security', copy: 'nav_security'},
  {to: '/algemene-voorwaarden', copy: 'nav_terms'},
  {to: '/privacy', copy: 'nav_privacy'},
  {to: '/cookies', copy: 'nav_cookies'},
  {to: '/herroepingsrecht#withdraw', copy: 'nav_withdrawal'},
  {to: '/shipping', copy: 'nav_shipping'},
  {to: '/warranty', copy: 'nav_warranty'},
  {to: '/end-use', copy: 'nav_end_use'},
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

function FooterNavLink({to, children}: {to: string; children: React.ReactNode}) {
  return (
    <NavLink
      end
      prefetch="viewport"
      to={to}
      className={({isActive}) =>
        `text-xs transition-colors flex items-center min-h-[44px] md:min-h-0 ${
          isActive
            ? 'text-[var(--color-text)]'
            : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

export function Footer({company, turnstileSiteKey}: FooterProps) {
  return (
    <footer className="mt-auto border-t border-[var(--color-border)]">
      <div className="site-footer-inner">
        {/* Newsletter - separated by a hairline + whitespace, not a card
            box. The form carries its own hierarchy. Consent lives on the
            Shopify customer, and this form is anonymous, so there is no
            signed-in subscription state to read and every visitor sees the
            same form. */}
        <div className="mb-8 pb-8 border-b border-[var(--color-border)]">
          <NewsletterSignup
            variant="footer"
            turnstileSiteKey={turnstileSiteKey ?? null}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Company identity */}
          <div className="md:col-span-1">
            <h3 className="gold-tag font-display text-sm font-bold tracking-[0.08em] uppercase text-[var(--color-gold)] mb-3">
              OpenDrone
            </h3>
            <Txt
              id="chrome.footer_run_by"
              as="p"
              className="text-[12px] text-[var(--color-text-muted)] mb-3 leading-relaxed"
            />
            <CompanyFooterBlock company={company} />
          </div>

          {/* Shop */}
          <div>
            <ColumnHeading id="chrome.heading_shop" />
            <nav className="flex flex-col gap-1.5">
              {SHOP_LINKS.map((link) => (
                <FooterNavLink key={link.to} to={link.to}>
                  <Txt id={`chrome.${link.copy}`} />
                </FooterNavLink>
              ))}
            </nav>
          </div>

          {/* Open Source + Company */}
          <div>
            <ColumnHeading id="chrome.heading_open_source" />
            <nav className="flex flex-col gap-1.5 mb-6">
              {SOCIAL_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors flex items-center min-h-[44px] md:min-h-0"
                >
                  <Txt id={`chrome.${link.copy}`} />
                </a>
              ))}
            </nav>
            <ColumnHeading id="chrome.heading_company" />
            <nav className="flex flex-col gap-1.5">
              {COMPANY_LINKS.map((link) => (
                <FooterNavLink key={link.to} to={link.to}>
                  <Txt id={`chrome.${link.copy}`} />
                </FooterNavLink>
              ))}
            </nav>
          </div>

          {/* Legal */}
          <div>
            <ColumnHeading id="chrome.heading_legal" />
            <nav className="flex flex-col gap-1.5">
              {LEGAL_LINKS.map((link) => (
                <FooterNavLink key={link.to} to={link.to}>
                  <Txt id={`chrome.${link.copy}`} />
                </FooterNavLink>
              ))}
            </nav>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-8 pt-5 border-t border-[var(--color-border)] flex flex-col md:flex-row items-center justify-between gap-3">
          {/* Year and legal entity stay in code: one is the clock, the other is
              the identity in `company.ts` that also feeds the JSON-LD. Only the
              licence sentence after them is editable. */}
          <p className="text-[12px] text-[var(--color-text-muted)] font-mono tracking-wide">
            &copy; {new Date().getFullYear()} {company.name}.{' '}
            <Txt id="chrome.footer_licence_line" />{' '}
            <Txt id="chrome.footer_site_source_line" />
          </p>
          <a
            href="https://github.com/OpenDrone-hw"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            aria-label={copyText('chrome.nav_github') ?? 'GitHub'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}
