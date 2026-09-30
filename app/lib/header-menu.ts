/**
 * The text links that live in the desktop header's menu button instead of the
 * bar: structure only, the words are the `chrome.*` copy ids. The phone drawer
 * carries the same destinations (HEADER_MENU in components/Header.tsx).
 */
export const HEADER_MENU_LINKS: ReadonlyArray<{to: string; copy: string}> = [
  {to: '/preorder', copy: 'chrome.nav_preorder'},
  {to: '/wholesale', copy: 'chrome.nav_trade'},
  {to: '/newsletter', copy: 'chrome.nav_newsletter'},
  {to: '/support', copy: 'chrome.nav_contact'},
];
