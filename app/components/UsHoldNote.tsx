import {Link} from 'react-router';
import {US_HOLD_COPY} from '~/lib/geo-availability';
import type {Locale} from '~/lib/i18n';

/**
 * "Not shipping to the US yet. Shops and retailers: contact us." The
 * no-checkout note for a US destination while US sales are on hold
 * (`usOnHold`), on the product page, the cart and the add-to-cart drawer.
 * "contact us" goes to the wholesale enquiry. Other no-checkout destinations
 * keep their shops/trade text.
 */
export function UsHoldNote({locale = 'en', className, linkClassName}: {locale?: Locale; className?: string; linkClassName?: string}) {
  const copy = US_HOLD_COPY[locale] ?? US_HOLD_COPY.en;
  return (
    <p className={className} role="note">
      {copy.line} {copy.trade}{' '}
      <Link prefetch="intent" to="/wholesale" className={linkClassName}>
        {copy.link}
      </Link>
      .
    </p>
  );
}
