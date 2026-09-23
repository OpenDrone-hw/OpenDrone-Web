import {Link} from 'react-router';
import {copyText} from '~/lib/copy';
import {shipMonth} from '~/lib/product-content';

/** Lowest current price per product handle, formatted ("€23.20"), from the
 *  catalog. A handle is missing or null when the catalog lacks it. */
export type HomePrices = Readonly<Record<string, string | null>>;

/**
 * The homepage promo line, one row under the header while the shop is open:
 * "PRE-ORDER · FC + ESC ship Oct 2026 · FC from €23.20 · ESC from €39.20".
 * The whole line links to /preorder. `ships` is the paid batch's promise
 * from `content/preorders.json`; a part with no price or date is left out.
 */
export function PreorderStrip({
  ships: shipsPromise,
  prices,
  className = '',
}: {
  ships: string | null;
  prices: HomePrices;
  className?: string;
}) {
  const fill = (
    key: string,
    token: string,
    value: string | null | undefined,
  ) => (value ? (copyText(`home.${key}`) ?? '').replace(token, value) : '');
  const ships = fill('promo_ships', '{month}', shipMonth(shipsPromise));
  const priced = [
    fill('promo_fc', '{price}', prices['openfc-lite']),
    fill('promo_esc', '{price}', prices.openesc),
  ].filter(Boolean);
  // Two groups, so a phone breaks the line between them, never mid-group.
  return (
    <Link
      prefetch="viewport"
      to="/preorder"
      className={`home-promo ${className}`.trim()}
    >
      <span className="home-promo-group">
        <strong className="home-promo-tag">{copyText('home.promo_tag')}</strong>
        {ships ? <span>{ships}</span> : null}
      </span>
      <span className="home-promo-group">
        {priced.map((part) => (
          <span key={part}>{part}</span>
        ))}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </span>
    </Link>
  );
}
