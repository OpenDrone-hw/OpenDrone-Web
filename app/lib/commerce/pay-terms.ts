/**
 * The pre-contract links under the app pay step, the ones a Shopify checkout shows. They reuse the footer's routes and
 * its chrome copy ids, so no legal text lives here. The preorder link points at the preorder article of the terms.
 */
export type PayTermLink = {to: string; copy: string};

export function payTermLinks(hasPreorder: boolean): PayTermLink[] {
  const links: PayTermLink[] = [
    {to: '/algemene-voorwaarden', copy: 'chrome.nav_terms'},
    {to: '/herroepingsrecht#withdraw', copy: 'chrome.nav_withdrawal'},
    {to: '/privacy', copy: 'chrome.nav_privacy'},
  ];
  if (hasPreorder) links.push({to: '/algemene-voorwaarden#art-7bis', copy: 'chrome.nav_preorder'});
  return links;
}
