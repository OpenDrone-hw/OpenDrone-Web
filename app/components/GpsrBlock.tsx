import type {CompanyIdentity} from '~/lib/company';
import {copy, copyText, editAttrs} from '~/lib/copy';
import {warningLanguages} from '~/lib/gpsr-languages';
import type {RegistrationNumber} from '~/lib/registrations';

/**
 * GPSR (EU) 2023/988 Art. 19 information for product listings: manufacturer
 * identity with postal and electronic address, the product identifier and
 * the safety warnings, available with the product's supporting information.
 * The email is plain text here on purpose: Art. 19 requires an electronic
 * address on the offer itself, so the site-wide no-mailto rule does not apply
 * to product pages. Strings live in content/copy/product-chrome.json under
 * the gpsr_* keys. English and the visitor country's languages
 * (`warningLanguages`) show; every other EU language sits in a folded
 * disclosure on the same page.
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

/** Which extra warnings a product carries, on top of the shared ones. */
export type SafetyKind = 'electronics' | 'frame' | 'motor' | 'accessory';

const SAFETY_KIND: Record<string, SafetyKind> = {
  'openfc-lite': 'electronics',
  openesc: 'electronics',
  openrx: 'electronics',
  openframe: 'frame',
  'openframe-spares': 'frame',
  openmotor: 'motor',
};

export function safetyKind(handle: string): SafetyKind {
  return SAFETY_KIND[handle] ?? 'accessory';
}

export function GpsrBlock({
  company,
  productTitle,
  sku,
  kind,
  country,
  registrations = [],
  compact = false,
}: {
  company: CompanyIdentity;
  productTitle: string;
  sku?: string | null;
  kind: SafetyKind;
  /** The visitor's country: which warning languages show unfolded. */
  country: string | null;
  /** Incutec's registration numbers for the visitor's country, when set. */
  registrations?: RegistrationNumber[];
  /** The containing disclosure already names this information. */
  compact?: boolean;
}) {
  const linesFor = (lang: string) => [
    ...warnings(`gpsr_warnings_${lang}`),
    ...warnings(`gpsr_warnings_${kind}_${lang}`),
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
      aria-label={copyText('product-chrome.gpsr_aria') ?? 'Manufacturer and safety information'}
      className={`${compact ? 'pb-6' : 'mt-6 border-t border-[var(--color-border)] pt-5'} text-[14px] leading-relaxed text-[var(--color-text)]`}
    >
      {!compact ? <p
        className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]"
        {...editAttrs('product-chrome.gpsr_heading')}
      >
        {copyText('product-chrome.gpsr_heading') ?? 'Manufacturer & safety information'}
      </p> : null}
      <p className="mb-2">
        {company.name}, {company.address} &middot; {company.email} &middot; KBO/BCE {company.kbo}
      </p>
      {registrations.length ? (
        <p className="mb-2">
          {registrations.map((r) => `${registrationLabel(r.kind)} ${r.value}`).join(' · ')}
        </p>
      ) : null}
      <p className="mb-4">
        {copyText('product-chrome.gpsr_product_label') ?? 'Product type'}: {productTitle}
        {sku ? (
          <>
            {' '}
            &middot; {copyText('product-chrome.buy_sku_prefix') ?? 'SKU'} {sku}
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
