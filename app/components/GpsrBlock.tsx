import type {CompanyIdentity} from '~/lib/company';
import {copy, copyText, editAttrs} from '~/lib/copy';

/**
 * GPSR (EU) 2023/988 Art. 19 information for product listings: manufacturer
 * identity with postal and electronic address, the product identifier, safety
 * warnings in EN/NL/FR/DE. Required before purchase by
 * docs/store-compliance.md section 1. Rendered as a quiet compliance strip at
 * the very bottom of the product page, deliberately outside the product story.
 * The email is plain text here on purpose: Art. 19 requires an electronic
 * address on the offer itself, so the site-wide no-mailto rule does not apply
 * to product pages. Strings live in content/copy/product-chrome.json under
 * the gpsr_* keys; the English list shows and the NL/FR/DE lists sit in a
 * folded disclosure on the same page, because product pages are English-only
 * chrome serving NL/FR/DE markets.
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

/** The age and assembly facts a buyer needs before paying, from the same
 *  safety data as this block: every part is 14+, and the electronics and
 *  motors are soldered in. */
export function buyerFacts(kind: SafetyKind): string {
  return kind === 'electronics' || kind === 'motor'
    ? (copyText('product-chrome.buy_facts_solder') ?? 'Age 14+ · needs soldering to install')
    : (copyText('product-chrome.buy_facts_age') ?? 'Age 14+');
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
      className="mt-16 border-t border-[var(--color-border)] py-8 text-[11px] leading-relaxed text-[var(--color-text-muted)]"
    >
      <div>
        <p
          className="mb-4 font-mono text-[10px] uppercase tracking-[0.2em]"
          {...editAttrs('product-chrome.gpsr_heading')}
        >
          {copyText('product-chrome.gpsr_heading') ??
            'Manufacturer & safety information'}
        </p>
        <p className="mb-2">
          {company.name}, {company.address} &middot; {company.email} &middot;{' '}
          KBO/BCE {company.kbo}
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
        {/* The shop is English, so the English lines show; the Dutch,
            French and German lines stay on the page, folded (GPSR Art. 9(7)
            asks for the languages of the markets served). */}
        {(() => {
          const linesFor = (lang: (typeof WARNING_LANGS)[number]) => [
            ...warnings(`gpsr_warnings_${lang}`),
            ...warnings(`gpsr_warnings_${kind}_${lang}`),
          ];
          const list = (lang: (typeof WARNING_LANGS)[number]) => {
            const lines = linesFor(lang);
            return lines.length ? (
              <ul key={lang} lang={lang} className="list-disc space-y-1 pl-4">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null;
          };
          const others = WARNING_LANGS.filter((lang) => lang !== 'en' && linesFor(lang).length);
          return (
            <>
              {list('en')}
              {others.length ? (
                <details className="gpsr-languages mt-4">
                  <summary className="cursor-pointer">
                    {copyText('product-chrome.gpsr_other_languages') ??
                      'Veiligheid · Sécurité · Sicherheit (NL / FR / DE)'}
                  </summary>
                  <div className="mt-3 grid gap-6 md:grid-cols-3">{others.map(list)}</div>
                </details>
              ) : null}
            </>
          );
        })()}
      </div>
    </section>
  );
}
