import type {ReactNode} from 'react';

/** The frame of the app-backed /shop pages (cart, order status, news): the site's own rail and type, a title. */
export function ShopFrame({title, children}: {title: string; children: ReactNode}) {
  return (
    <main className="page-shell app-shop">
      <h1 className="app-shop-title">{title}</h1>
      {children}
    </main>
  );
}
