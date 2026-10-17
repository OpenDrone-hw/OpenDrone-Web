import type {ReactNode} from 'react';
import {Link} from 'react-router';

/** The frame of the app-backed /shop pages: a test-mode bar, the page title and the cart link. */
export function ShopFrame({title, children}: {title: string; children: ReactNode}) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <p role="status" className="mb-6 border px-3 py-2 text-sm">
        Test mode: no real payments, no real orders.
      </p>
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <nav className="flex gap-4">
          <Link to="/shop">Shop</Link>
          <Link to="/shop/news">News</Link>
          <Link to="/shop/cart">Cart</Link>
        </nav>
      </header>
      {children}
    </main>
  );
}
