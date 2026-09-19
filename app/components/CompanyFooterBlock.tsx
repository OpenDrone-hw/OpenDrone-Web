import {Link} from 'react-router';
import type {CompanyIdentity} from '~/lib/company';

/**
 * Legal identity block for the selling entity. Used in Footer and on the
 * /legal imprint page. Product branding (OpenDrone/OpenFC/OpenESC) is
 * intentionally absent - this block is the seller, not the product.
 *
 * `company.email` is intentionally not rendered as a mailto here: scrapers
 * pull plaintext mailto links from every page they visit. The legal pages
 * (/privacy, /algemene-voorwaarden, /herroepingsrecht, /warranty) still
 * display it where EU B2C disclosure requires it. Everything else funnels
 * through /support.
 */
export function CompanyFooterBlock({company}: {company: CompanyIdentity}) {
  return (
    <address className="not-italic flex flex-col gap-1.5 font-mono text-xs text-[var(--color-text-muted)] leading-relaxed">
      <p className="text-[var(--color-text)] font-bold">{company.name}</p>
      <p>{company.address}</p>
      <p>KBO/BCE: {company.kbo}</p>
      <p>BTW/VAT: {company.vat}</p>
      <p>
        <Link
          to="/support"
          className="hover:text-[var(--color-text)] transition-colors underline underline-offset-2"
        >
          Contact via support
        </Link>
      </p>
      {company.tel && company.tel !== '[pending]' ? <p>{company.tel}</p> : null}
    </address>
  );
}
