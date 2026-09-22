import {Link} from 'react-router';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/** The lowest current price of the flight controller and the ESC, already
 *  formatted ("€23.20"), from the catalog. Null when the catalog lacks one. */
export type StripPrices = {fc: string | null; esc: string | null};

/**
 * The homepage's launch card: what OpenDrone sells, the price hook and when
 * the stack ships, which sizes the parts are for, and the ways on (what a
 * build needs, how preorders work, coming from DJI, buying as a gift).
 * Rendered only while the shop is open; `ships` is the paid batch's promise
 * from `content/preorders.json`, e.g. "ships late October 2026". It paints
 * with the page and never waits for the 3D models.
 */
export function PreorderStrip({
  ships,
  prices = null,
  className = '',
}: {
  ships: string | null;
  prices?: StripPrices | null;
  className?: string;
}) {
  const priced = Boolean(prices?.fc && prices?.esc);
  const stack = ships
    ? (
        (priced ? copyText('home.preorder_strip_prices') : null) ??
        copyText('home.preorder_strip_stack') ??
        ''
      )
        .replace('{fc}', prices?.fc ?? '')
        .replace('{esc}', prices?.esc ?? '')
        .replace('{ships}', ships)
    : '';
  return (
    <div className={`preorder-strip-home ${className}`.trim()} role="note">
      <Txt id="home.preorder_strip_what" as="p" className="preorder-strip-home-what" />
      <p className="preorder-strip-home-text">
        <Txt id="home.preorder_strip_tag" as="strong" className="preorder-strip-home-tag" />
        {stack ? <span>{stack}</span> : null}
      </p>
      <Txt id="home.preorder_strip_sizes" as="p" className="preorder-strip-home-sizes" />
      {/* One button style for every way on: the first is the filled one. */}
      <p className="preorder-strip-home-links">
        <Link prefetch="viewport" to="/products#new-to-fpv" className="btn-primary btn-sm">
          <Txt id="home.preorder_strip_new" />
        </Link>
        <Link prefetch="viewport" to="/preorder" className="btn-secondary btn-sm">
          <Txt id="home.preorder_strip_how" />
        </Link>
        <Link prefetch="viewport" to="/products#coming-from-dji" className="btn-secondary btn-sm">
          <Txt id="home.preorder_strip_dji" fallback="Coming from DJI?" />
        </Link>
        <Link prefetch="viewport" to="/preorder#gift" className="btn-secondary btn-sm">
          <Txt id="home.preorder_strip_gift" fallback="Buying as a gift?" />
        </Link>
      </p>
    </div>
  );
}
