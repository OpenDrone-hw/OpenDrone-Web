import {Link} from 'react-router';
import type {CompanyIdentity} from '~/lib/company';
import {copy, copyText, editAttrs} from '~/lib/copy';

/**
 * GPSR (EU) 2023/988 Art. 19 information for product listings: manufacturer
 * identity with postal and electronic address, the product identifier, safety
 * warnings in EN/NL/FR, and the EU DoC pointer. Required before purchase by
 * docs/store-compliance.md section 1. Rendered as a quiet compliance strip at
 * the very bottom of the product page, deliberately outside the product story.
 * The email is plain text here on purpose: Art. 19 requires an electronic
 * address on the offer itself, so the site-wide no-mailto rule does not apply
 * to product pages. Strings live in content/copy/product-chrome.json under
 * the gpsr_* keys; the warning lists render in all three languages at once
 * because product pages are English-only chrome serving a NL/FR market.
 */

const WARNING_LANGS = ['en', 'nl', 'fr'] as const;

export function GpsrBlock({
  company,
  productTitle,
  sku,
}: {
  company: CompanyIdentity;
  productTitle: string;
  sku?: string | null;
}) {
  return (
    <section
      aria-label="Manufacturer and safety information"
      className="mt-16 border-t border-[var(--color-border)] px-6 py-8 text-[11px] leading-relaxed text-[var(--color-text-muted)]"
    >
      <div className="mx-auto max-w-6xl">
        <p
          className="mb-4 font-mono text-[10px] uppercase tracking-[0.2em]"
          {...editAttrs('product-chrome.gpsr_heading')}
        >
          {copyText('product-chrome.gpsr_heading') ??
            'Manufacturer & safety information'}
        </p>
        <p className="mb-2">
          {company.name}, {company.address} &middot; {company.email} &middot;{' '}
          KBO/BCE {company.kbo} &middot;{' '}
          <Link to="/doc" className="underline underline-offset-2">
            {copyText('product-chrome.gpsr_doc_link') ??
              'EU Declaration of Conformity'}
          </Link>
        </p>
        <p className="mb-4">
          {copyText('product-chrome.gpsr_product_label') ?? 'Product type'}:{' '}
          {productTitle}
          {sku ? (
            <>
              {' '}
              &middot; {copyText('product-chrome.buy_sku_prefix') ?? 'SKU'}{' '}
              {sku}
            </>
          ) : null}
        </p>
        <div className="grid gap-6 md:grid-cols-3">
          {WARNING_LANGS.map((lang) => {
            const lines = copy(`product-chrome.gpsr_warnings_${lang}`);
            if (!Array.isArray(lines) || lines.length === 0) return null;
            return (
              <ul key={lang} lang={lang} className="list-disc space-y-1 pl-4">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            );
          })}
        </div>
      </div>
    </section>
  );
}
