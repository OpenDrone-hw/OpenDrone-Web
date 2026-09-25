/**
 * The product families, the grouping key shared by the header dropdowns
 * and the listing's filter rail.
 *
 * The key is the `family` in `content/products/<handle>.json`, which is
 * also the word the card eyebrow shows. It used to be Shopify's
 * `productType`, a separate and shorter vocabulary that died with the
 * store; the catalog feed's `public_categ_ids` is empty today, so the
 * content files are the only source and `familyOf` in app/lib/catalog.ts
 * reads them.
 *
 * `app/lib/families.test.ts` asserts every family below exists in a
 * content file: a renamed family that only got changed in one place
 * silently empties a header dropdown, which is exactly what this list is
 * here to prevent.
 *
 * Bundler-free (relative imports) so the test can load it.
 */

export type Family = {
  /** The `family` value in the content files. */
  type: string;
  /** Terse chip label in the desktop header. */
  short: string;
  /** Spelled-out label for the mobile drawer. */
  long: string;
  /** The family's representative product page. */
  to: string;
  /** Copy id of the heading on the listing's filter rail. */
  copyId: string;
};

export const FAMILIES: Family[] = [
  {
    type: 'Flight Controller',
    short: 'FC',
    long: 'Flight Controllers',
    to: '/products/openfc-lite',
    copyId: 'collections-all.category_flight_controller',
  },
  {
    type: '4-in-1 ESC',
    short: 'ESC',
    long: 'ESCs',
    to: '/products/openesc',
    copyId: 'collections-all.category_esc',
  },
  {
    type: 'ELRS Receiver',
    short: 'RX',
    long: 'Receivers',
    to: '/products/openrx',
    copyId: 'collections-all.category_receiver',
  },
  {
    type: 'Motors',
    short: 'Motors',
    long: 'Motors',
    to: '/products/openmotor',
    copyId: 'collections-all.category_motors',
  },
  {
    type: 'Carbon Frame',
    short: 'Frame',
    long: 'Frames',
    to: '/products/openframe',
    copyId: 'collections-all.category_frame',
  },
];

/**
 * The pilot shorthand a product tile shows under its title. The `family`
 * value stays the grouping key; only the tile label is shortened.
 */
const TILE_LABELS: Readonly<Record<string, string>> = {
  'Flight Controller': 'FC',
  '4-in-1 ESC': '4in1 ESC',
  'ELRS Receiver': 'ELRS RX',
  'Carbon Frame': 'Frame',
  Motors: 'Motors',
};

export function tileFamilyLabel(family: string | null | undefined): string | null {
  if (!family) return null;
  return TILE_LABELS[family] ?? family;
}
