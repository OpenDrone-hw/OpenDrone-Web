/**
 * The header's navigation, as data: the Shop panel's product families, the
 * plain links beside it, and what the mobile drawer lists. The header, the
 * drawer and the test read this one list, so a page that leaves it is a test
 * failure, not a page nobody can reach.
 *
 * Bundler-free (relative imports) so the test can load it.
 */
import {FAMILIES} from './families.ts';

export type ShopFamily = {
  /** The catalog `productType`, also the `?type=` filter of the listing. */
  type: string;
  /** Copy slug: `chrome.family_<slug>_long` is the label. */
  slug: string;
  /** Label if the copy store has none. */
  label: string;
  /** The listing filtered to this family. */
  to: string;
  /** Copy id of the one-line note under the label, when the family has one. */
  noteCopy?: string;
};

const SLUG: Record<string, string> = {
  'Flight Controller': 'flight_controller',
  '4-in-1 ESC': 'esc',
  'ELRS Receiver': 'receiver',
  Motors: 'motors',
  'Carbon Frame': 'frame',
};

function typeLink(type: string): string {
  return `/products?type=${encodeURIComponent(type)}`;
}

/** The families in shop order: the boards, then everything sold beside them. */
export const SHOP_FAMILIES: readonly ShopFamily[] = [
  ...FAMILIES.map((f) => ({
    type: f.type,
    slug: SLUG[f.type] ?? f.type.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    label: f.long,
    to: typeLink(f.type),
  })),
  {
    type: 'Accessory',
    slug: 'accessories',
    label: 'Accessories',
    to: typeLink('Accessory'),
    noteCopy: 'chrome.family_accessories_note',
  },
];

export type NavLinkItem = {to: string; copy: string; label: string};

/** Plain links of the bar, in order. `Newsletter` folds into the Shop panel
 *  below 1200px (`collapses`). */
export const BAR_LINKS: readonly (NavLinkItem & {collapses?: boolean})[] = [
  {to: '/preorder', copy: 'chrome.nav_preorder', label: 'Preorders'},
  {to: '/newsletter', copy: 'chrome.nav_newsletter', label: 'Newsletter', collapses: true},
  {to: '/support', copy: 'chrome.nav_support', label: 'Support'},
];

/** Besides the families, the Shop panel lists the whole catalogue and the
 *  trade page. */
export const SHOP_EXTRAS: readonly NavLinkItem[] = [
  {to: '/products', copy: 'chrome.nav_all_products', label: 'All products'},
  {to: '/wholesale', copy: 'chrome.nav_trade', label: 'Wholesale'},
];

/** The routes under which the Shop item of the bar reads as current. */
export function isShopPath(pathname: string): boolean {
  return (
    pathname === '/products' ||
    pathname.startsWith('/products/') ||
    pathname.startsWith('/collections') ||
    pathname === '/wholesale' ||
    pathname.startsWith('/wholesale/')
  );
}
