import type {CompanyIdentity} from '~/lib/company';
import {copy, copyText, editAttrs} from '~/lib/copy';
import {warningLanguages} from '~/lib/gpsr-languages';
import {legacySafetyKind, safetyWarnings, safetyWarningsApproved, type SafetyFamily} from '~/lib/product-safety';
import type {RegistrationNumber} from '~/lib/registrations';

/**
 * GPSR (EU) 2023/988 Art. 19 information for product listings: manufacturer
 * identity with postal and electronic address, the product identifier and
 * the safety warnings, available with the product's supporting information.
 * The email is plain text here on purpose: Art. 19 requires an electronic
 * address on the offer itself, so the site-wide no-mailto rule does not apply
 * to product pages. Labels and the product framing line live in
 * content/copy/product-chrome.json under the gpsr_* keys; the safety
 * warnings come from content/product-safety.json once that file is approved
 * (`safetyWarnings`); until then the existing gpsr_warnings_<kind>_<lang>
 * lines keep showing, unchanged. English and the visitor
 * country's languages (`warningLanguages`) show; every other EU language
 * sits in a folded disclosure on the same page.
 */

function warnings(key: string): string[] {
  const value = copy(`product-chrome.${key}`);
  return Array.isArray(value) ? value : [];
}

/** A language's own name for itself ("Deutsch"), falling back to the code. */
function languageName(lang: string): string {
  try {
    const name = new Intl.DisplayNames([lang], {type: 'language'}).of(lang) ?? lang;
    return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  } catch {
    return lang.toUpperCase();
  }
}

/** Names of the registration numbers shown with the manufacturer. */
const REGISTRATION_LABELS: Record<RegistrationNumber['kind'], string> = {
  weee: 'WEEE reg. no.',
  packaging: 'Packaging reg. no.',
  idu: 'IDU',
};

function registrationLabel(kind: RegistrationNumber['kind']): string {
  if (kind === 'weee') return copyText('product-chrome.gpsr_reg_weee') ?? REGISTRATION_LABELS.weee;
  if (kind === 'packaging') {
    return copyText('product-chrome.gpsr_reg_packaging') ?? REGISTRATION_LABELS.packaging;
  }
  return copyText('product-chrome.gpsr_reg_idu') ?? REGISTRATION_LABELS[kind];
}

export function GpsrBlock({
  company,
  productTitle,
  sku,
  family,
  country,
  registrations = [],
  compact = false,
  brand = null,
}: {
  company: CompanyIdentity;
  productTitle: string;
  sku?: string | null;
  /** The safety-leaflet family; null for accessories. */
  family: SafetyFamily | null;
  /** The visitor's country: which warning languages show unfolded. */
  country: string | null;
  /** Incutec's registration numbers for the visitor's country, when set. */
  registrations?: RegistrationNumber[];
  /** The containing disclosure already names this information. */
  compact?: boolean;
  /**
   * A third-party brand (Shopify vendor) the product is made under. Incutec
   * is then the EU importer, not the manufacturer. No manufacturer postal
   * address is on file for these brands, so only the name shows.
   */
  brand?: string | null;
}) {
  const linesFor = (lang: string) => [
    ...warnings(`gpsr_warnings_${lang}`),
    ...(safetyWarningsApproved()
      ? safetyWarnings(family, lang)
      : warnings(`gpsr_warnings_${legacySafetyKind(family)}_${lang}`)),
  ];
  const {shown, folded} = warningLanguages(country);
  const list = (lang: string, labelled: boolean) => {
    const lines = linesFor(lang);
    return lines.length ? (
      <div key={lang} lang={lang}>
        {labelled ? <p className="mb-1 font-medium text-[var(--color-text)]">{languageName(lang)}</p> : null}
        <ul className="list-disc space-y-1 pl-4">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    ) : null;
  };
  const others = folded.filter((lang) => linesFor(lang).length);
  return (
    <section
      aria-label={copyText('product-chrome.gpsr_aria') ?? 'Product safety'}
      className={`${compact ? 'pb-6' : 'mt-6 border-t border-[var(--color-border)] pt-5'} text-[14px] leading-relaxed text-[var(--color-text)]`}
    >
      {!compact ? <p
        className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
        {...editAttrs('product-chrome.gpsr_heading')}
      >
        {copyText('product-chrome.gpsr_heading') ?? 'Product safety'}
      </p> : null}
      {brand ? (
        <p className="mb-2">
          <span {...editAttrs('product-chrome.gpsr_manufacturer_label')}>
            {copyText('product-chrome.gpsr_manufacturer_label') ?? 'Brand and manufacturer'}
          </span>
          : {brand}
        </p>
      ) : null}
      <p className="mb-2">
        {brand ? (
          <>
            <span {...editAttrs('product-chrome.gpsr_importer_label')}>
              {copyText('product-chrome.gpsr_importer_label') ?? 'EU importer'}
            </span>
            :{' '}
          </>
        ) : null}
        {company.name}, {company.address}, {company.email}, KBO/BCE {company.kbo}
      </p>
      {registrations.length ? (
        <p className="mb-2">
          {registrations.map((r) => `${registrationLabel(r.kind)} ${r.value}`).join(', ')}
        </p>
      ) : null}
      <p className="mb-4">
        {copyText('product-chrome.gpsr_product_label') ?? 'Product type'}: {productTitle}
        {sku ? (
          <>
            , {copyText('product-chrome.buy_sku_prefix') ?? 'SKU'} {sku}
          </>
        ) : null}
      </p>
      <div className="grid gap-4">{shown.map((lang) => list(lang, shown.length > 1))}</div>
      {others.length ? (
        <details className="gpsr-languages mt-4">
          <summary className="cursor-pointer text-[var(--color-text-muted)]">
            {copyText('product-chrome.gpsr_other_languages') ?? 'Other EU languages'}
          </summary>
          <div className="mt-3 grid gap-6 md:grid-cols-2">{others.map((lang) => list(lang, true))}</div>
        </details>
      ) : null}
    </section>
  );
}
