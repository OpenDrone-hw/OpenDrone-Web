import {Link} from 'react-router';
import type {CompanyIdentity} from '~/lib/company';
import {copy, copyText, editAttrs} from '~/lib/copy';

/**
 * GPSR (EU) 2023/988 Art. 19 information for product listings: manufacturer
 * identity with postal and electronic address, the product identifier, safety
 * warnings in EN/NL/FR/DE, and the EU DoC pointer. Required before purchase by
 * docs/store-compliance.md section 1. Rendered as a quiet compliance strip at
 * the very bottom of the product page, deliberately outside the product story.
 * The email is plain text here on purpose: Art. 19 requires an electronic
 * address on the offer itself, so the site-wide no-mailto rule does not apply
 * to product pages. Strings live in content/copy/product-chrome.json under
 * the gpsr_* keys; the warning lists render in all four languages at once
 * because product pages are English-only chrome serving NL/FR/DE markets.
 */

const WARNING_LANGS = ['en', 'nl', 'fr', 'de'] as const;

/**
 * German warnings for DE and AT (GPSR Art. 9(7)): used until the same lines
 * are added to content/copy/product-chrome.json as gpsr_warnings_*_de,
 * which then take over. Translation pending a compliance check.
 */
const DE_FALLBACK: Record<string, string[]> = {
  gpsr_warnings_de: [
    'Kein Spielzeug. Nicht für Personen unter 14 Jahren; Minderjährige nur unter Aufsicht eines Erwachsenen.',
    'Bauteil für selbstgebaute unbemannte Luftfahrzeuge: Der Erbauer ist für das zusammengebaute Luftfahrzeug und dessen rechtmäßigen Betrieb verantwortlich.',
  ],
  gpsr_warnings_electronics_de: [
    'LiPo-Akkus können sich bei Beschädigung, Kurzschluss oder Überladung entzünden; niemals unbeaufsichtigt laden.',
    'Propeller vor Prüfstandtests, Konfiguration oder Firmware-Updates entfernen.',
    'Die Spannungs- und Stromgrenzen in den Spezifikationen einhalten; Verpolung zerstört die Platine.',
  ],
  gpsr_warnings_frame_de: [
    'Kohlefaser leitet Strom: Verkabelung und Platinen gegen Platten und Arme isolieren.',
    'Carbonkanten können scharf sein; Carbonstaub vom Sägen oder Schleifen ist beim Einatmen gesundheitsschädlich, daher nass arbeiten und eine Maske tragen.',
  ],
  gpsr_warnings_motor_de: [
    'Propeller vor Prüfstandtests, Konfiguration oder Firmware-Updates entfernen.',
    'Drehende Motoren und Propeller verursachen schwere Schnittverletzungen; Abstand halten, wenn das Luftfahrzeug scharfgeschaltet ist.',
    'Motoren werden im Betrieb heiß; vor dem Anfassen abkühlen lassen.',
  ],
};

function warnings(key: string): string[] {
  const value = copy(`product-chrome.${key}`);
  if (Array.isArray(value)) return value;
  return DE_FALLBACK[key] ?? [];
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
}: {
  company: CompanyIdentity;
  productTitle: string;
  sku?: string | null;
  kind: SafetyKind;
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
        <div className="grid gap-6 md:grid-cols-4">
          {WARNING_LANGS.map((lang) => {
            const lines = [
              ...warnings(`gpsr_warnings_${lang}`),
              ...warnings(`gpsr_warnings_${kind}_${lang}`),
            ];
            if (lines.length === 0) return null;
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
