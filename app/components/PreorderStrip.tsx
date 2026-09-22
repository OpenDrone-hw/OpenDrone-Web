import {Link} from 'react-router';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * The homepage's launch line: preorders are open, when the stack ships, and
 * the two ways on (how preorders work, the catalogue). Rendered only while
 * the shop is open; `ships` is the paid batch's promise from
 * `content/preorders.json`, e.g. "ships late October 2026".
 */
export function PreorderStrip({
  ships,
  className = '',
}: {
  ships: string | null;
  className?: string;
}) {
  const stack = ships
    ? (copyText('home.preorder_strip_stack') ?? '').replace('{ships}', ships)
    : '';
  return (
    <div className={`preorder-strip-home ${className}`.trim()} role="note">
      <p className="preorder-strip-home-text">
        <Txt id="home.preorder_strip_tag" as="strong" className="preorder-strip-home-tag" />
        {stack ? <span>{stack}</span> : null}
      </p>
      <p className="preorder-strip-home-links">
        <Link prefetch="viewport" to="/preorder" className="preorder-strip-home-primary">
          <Txt id="home.preorder_strip_how" />
        </Link>
        <Link prefetch="viewport" to="/products" className="preorder-strip-home-secondary">
          <Txt id="home.preorder_strip_shop" />
        </Link>
      </p>
    </div>
  );
}
