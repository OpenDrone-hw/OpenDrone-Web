/**
 * Safety warnings for the product-page safety block, read from
 * content/product-safety.json. The file holds only statements approved in
 * the Incutec safety leaflet; nothing renders until `approved` is true and
 * `documentVersion` is set. Vite and node:test read the same data.
 */

/** Product families as the safety leaflet groups them. */
export type SafetyFamily = 'fc' | 'esc' | 'rx' | 'frame' | 'motor';

export type ProductSafetyFile = {
  approved?: boolean;
  documentId?: string;
  documentVersion?: number | string | null;
  /** family -> language -> warning lines, in leaflet order. */
  families?: Partial<Record<SafetyFamily, Record<string, string[]>>>;
};

const FAMILY_BY_HANDLE: Record<string, SafetyFamily> = {
  'openfc-lite': 'fc',
  openesc: 'esc',
  openrx: 'rx',
  openframe: 'frame',
  'openframe-spares': 'frame',
  openmotor: 'motor',
};

/** The leaflet family a product handle belongs to; null for accessories. */
export function safetyFamily(handle: string): SafetyFamily | null {
  return FAMILY_BY_HANDLE[handle] ?? null;
}

function loadProductSafety(): ProductSafetyFile {
  if (import.meta.env) {
    const files = import.meta.glob<{default: ProductSafetyFile}>('/content/product-safety.json', {eager: true});
    return Object.values(files)[0]?.default ?? {};
  }
  // node:test: no bundler, read the same file.
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  // A joined path, so Vite does not emit the raw file as a public asset.
  return fs ? (JSON.parse(fs.readFileSync(new URL(['..', '..', 'content', 'product-safety.json'].join('/'), import.meta.url), 'utf8')) as ProductSafetyFile) : {};
}

/** The safety data as committed. */
export const PRODUCT_SAFETY: ProductSafetyFile = loadProductSafety();

/** True only when the file is marked approved against a named leaflet version. */
export function safetyWarningsApproved(file: ProductSafetyFile = PRODUCT_SAFETY): boolean {
  const version = file.documentVersion;
  return file.approved === true && version !== null && version !== undefined && String(version).trim() !== '';
}

/** Approved warning lines for one family and language; empty when the
 *  file is not approved, the family is unknown or the language is missing. */
export function safetyWarnings(
  family: SafetyFamily | null,
  lang: string,
  file: ProductSafetyFile = PRODUCT_SAFETY,
): string[] {
  if (!family || !safetyWarningsApproved(file)) return [];
  const lines = file.families?.[family]?.[lang];
  return Array.isArray(lines) ? lines.filter((l) => typeof l === 'string' && l.trim() !== '') : [];
}
