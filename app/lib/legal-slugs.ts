/**
 * URL slugs for the translated regulatory pages. This file is imported
 * by `app/routes.ts` (which runs in the vite-node config loader and
 * cannot resolve the `~` alias), so it must have no non-relative
 * imports and no runtime dependencies.
 */
export const LEGAL_SLUGS = [
  'algemene-voorwaarden',
  'privacy',
  'cookies',
  'herroepingsrecht',
  'shipping',
  'warranty',
  'recycling',
  'security',
  'end-use',
  'legal',
  'cookie-settings',
  'terms',
] as const;

export type LegalPathSlug = (typeof LEGAL_SLUGS)[number];
