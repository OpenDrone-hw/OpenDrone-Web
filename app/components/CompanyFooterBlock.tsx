import type {CompanyIdentity} from '~/lib/company';
import type {Locale} from '~/lib/i18n';

/** Labels of the block in the imprint's language, matching terms Art. 1. */
const LABELS: Record<Locale, {register: string; email: string; tel: string}> = {
  en: {register: 'RPR Leuven', email: 'Sales and legal', tel: 'Tel'},
  nl: {register: 'RPR Leuven', email: 'Verkoop en juridisch', tel: 'Tel'},
  fr: {register: 'RPM Louvain', email: 'Ventes et juridique', tel: 'Tél.'},
};

/**
 * Legal identity block for the selling entity, on the /legal imprint page.
 * Product branding (OpenDrone/OpenFC/OpenESC) is intentionally absent - this
 * block is the seller, not the product.
 *
 * The email address is shown as a mailto link: a web shop owes buyers a
 * direct electronic contact next to its company details (Art. III.74 WER),
 * and a buyer looks for it here. It is the sales and legal address; support
 * runs through /support. The telephone number is the seller's legal contact,
 * not a support line.
 */
export function CompanyFooterBlock({company, locale = 'en'}: {company: CompanyIdentity; locale?: Locale}) {
  const l = LABELS[locale] ?? LABELS.en;
  return (
    // The same sans type as the footer links; only the column labels are
    // mono. Registration numbers use tabular figures so they line up.
    <address className="company-block not-italic flex flex-col gap-1 font-sans text-[13px] leading-[1.6] text-[var(--color-text-muted)]">
      <p className="font-semibold text-[var(--color-text)]">{company.name}</p>
      <p>{company.address}</p>
      <p className="tabular-nums">KBO/BCE: {company.kbo} ({l.register})</p>
      <p className="tabular-nums">BTW/VAT: {company.vat}</p>
      {company.email ? (
        <p>
          {l.email}:{' '}
          <a
            href={`mailto:${company.email}`}
            className="hover:text-[var(--color-text)] transition-colors underline underline-offset-2"
          >
            {company.email}
          </a>
        </p>
      ) : null}
      {company.tel && company.tel !== '[pending]' ? (
        <p>
          {l.tel}: <span className="tabular-nums">{company.tel}</span>
        </p>
      ) : null}
    </address>
  );
}
