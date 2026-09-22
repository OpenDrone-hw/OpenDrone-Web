import {Link} from 'react-router';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

/**
 * The homepage's launch line: what OpenDrone sells, that preorders are
 * open and when the stack ships, and the two ways on (how preorders work,
 * and what a build needs for a buyer new to FPV). Rendered only while
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
      <Txt id="home.preorder_strip_what" as="p" className="preorder-strip-home-what" />
      <p className="preorder-strip-home-text">
        <Txt id="home.preorder_strip_tag" as="strong" className="preorder-strip-home-tag" />
        {stack ? <span>{stack}</span> : null}
      </p>
      {/* Two equal actions: how preorders work, and what a build needs
          for a buyer new to FPV. The DJI answer is a plain text link. */}
      <p className="preorder-strip-home-links">
        <Link prefetch="viewport" to="/products#new-to-fpv" className="preorder-strip-home-primary">
          <Txt id="home.preorder_strip_new" />
        </Link>
        <Link
          prefetch="viewport"
          to="/preorder"
          className="preorder-strip-home-primary bg-transparent! text-[var(--color-text)]! border border-[var(--color-border-strong)] hover:border-[var(--color-gold)]"
        >
          <Txt id="home.preorder_strip_how" />
        </Link>
        <Link prefetch="viewport" to="/products#coming-from-dji" className="preorder-strip-home-secondary">
          <Txt id="home.preorder_strip_dji" fallback="Coming from DJI?" />
        </Link>
      </p>
    </div>
  );
}
