import {Txt} from '~/components/Txt';
import type {CompanyIdentity} from '~/lib/company';

/**
 * Legal identity block for the selling entity. Used in Footer and on the
 * /legal imprint page. Product branding (OpenDrone/OpenFC/OpenESC) is
 * intentionally absent - this block is the seller, not the product.
 *
 * The email address is shown as a mailto link: a web shop owes buyers a
 * direct electronic contact next to its company details (Art. III.74 WER),
 * and a buyer looks for it here.
 */
export function CompanyFooterBlock({company}: {company: CompanyIdentity}) {
  return (
    // The same sans type as the footer links; only the column labels are
    // mono. Registration numbers use tabular figures so they line up.
    <address className="company-block not-italic flex flex-col gap-1 font-sans text-[13px] leading-[1.6] text-[var(--color-text-muted)]">
      <p className="font-semibold text-[var(--color-text)]">{company.name}</p>
      <p>{company.address}</p>
      <p className="tabular-nums">KBO/BCE: {company.kbo}</p>
      <p className="tabular-nums">BTW/VAT: {company.vat}</p>
      {company.email ? (
        <p>
          <Txt id="chrome.footer_email_label" />:{' '}
          <a
            href={`mailto:${company.email}`}
            className="hover:text-[var(--color-text)] transition-colors underline underline-offset-2"
          >
            {company.email}
          </a>
        </p>
      ) : null}
      {company.tel && company.tel !== '[pending]' ? <p>{company.tel}</p> : null}
    </address>
  );
}
