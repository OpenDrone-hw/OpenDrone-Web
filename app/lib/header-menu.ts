/**
 * The text links that live in the desktop header's menu button instead of the
 * bar: structure only, the words are the `chrome.*` copy ids. The phone drawer
 * carries the same destinations (HEADER_MENU in components/Header.tsx). The
 * firmware page is reached from Firmware guides and the footer, not from here.
 */
export const HEADER_MENU_LINKS: ReadonlyArray<{to: string; copy: string}> = [
  {to: '/preorder', copy: 'chrome.nav_preorder'},
  {to: '/wholesale', copy: 'chrome.nav_trade'},
  {to: '/newsletter', copy: 'chrome.nav_newsletter'},
  {to: '/owners', copy: 'chrome.nav_owners'},
  {to: '/guides', copy: 'chrome.nav_guides'},
  {to: '/support', copy: 'chrome.nav_contact'},
];
