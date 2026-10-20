import type {ReactNode} from 'react';

/** The frame of the app-backed /shop pages (cart, order status, news): the site's own rail and type, a title.
 *  `wide` is the two-column checkout. */
export function ShopFrame({title, children, wide = false}: {title: string; children: ReactNode; wide?: boolean}) {
  return (
    <div className={`page-shell app-shop${wide ? ' app-shop-wide' : ''}`}>
      <h1 className="app-shop-title">{title}</h1>
      {children}
    </div>
  );
}
