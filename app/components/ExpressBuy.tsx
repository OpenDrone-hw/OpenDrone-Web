import {useEffect, useState} from 'react';
import {useLocation, useRouteLoaderData, useSearchParams} from 'react-router';
import {LoaderCircle} from 'lucide-react';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {expressLinesField} from '~/lib/hero-build';
import {trackEvent} from '~/lib/growth/plausible';

/** The values `/api/shopify/cart` returns an express purchase with (`EXPRESS_REFUSED`). */
const REFUSALS: Record<string, () => string> = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the query value
  'sold-out': () =>
    copyText('product-chrome.express_sold_out') ??
    'Not enough left in stock just now. Nothing was charged. Try fewer, or pre-order.',
  // eslint-disable-next-line @typescript-eslint/naming-convention -- the query value
  'eu-only': () =>
    copyText('product-chrome.express_eu_only') ?? 'In-stock boards ship to EU addresses only. Pre-order ships worldwide.',
};

/** Why the last express purchase went no further, from the `buy` query
 *  parameter it came back with, or null. */
export function useExpressRefusal(): string | null {
  const [params] = useSearchParams();
  const reason = params.get('buy');
  return reason && Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason]() : null;
}

/**
 * The Buy now lane: a plain form post that the server turns into a Shopify
 * checkout holding only these in-stock lines (`EXPRESS_INTENT`). It never
 * touches the session cart, and works without JavaScript. The label keeps
 * its width while the browser leaves for checkout.
 */
export function ExpressBuy({
  lines,
  quantity = 1,
  children,
  className = 'btn-primary',
  product,
  disabled = false,
}: {
  lines: ReadonlyArray<{sku: string; quantity: number}>;
  quantity?: number;
  children: React.ReactNode;
  className?: string;
  product?: string;
  disabled?: boolean;
}) {
  const country = useRouteLoaderData<RootLoader>('root')?.visitorCountry ?? null;
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  // Back from checkout through the browser's cache: the button is live again.
  useEffect(() => {
    const reset = () => setBusy(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  // Back to this page (without an old refusal) if it cannot go ahead.
  const back = new URLSearchParams(location.search);
  back.delete('buy');
  const returnTo = `${location.pathname}${back.size ? `?${back.toString()}` : ''}`;
  return (
    <form
      method="post"
      action="/api/shopify/cart"
      className="add-to-cart-form express-buy"
      onSubmit={(event) => {
        if (busy || disabled) {
          event.preventDefault();
          return;
        }
        setBusy(true);
        trackEvent('Buy Now', {props: {product: product ?? 'unknown'}});
      }}
    >
      <input type="hidden" name="intent" value="buy-now" />
      <input type="hidden" name="lines" value={expressLinesField(lines, quantity)} />
      <input type="hidden" name="return" value={returnTo} />
      {country ? <input type="hidden" name="country" value={country} /> : null}
      <button type="submit" className={className} disabled={disabled} aria-busy={busy || undefined}>
        <span className={`btn-label cart-action-label${busy ? ' is-busy' : ''}`}>
          {busy ? (
            <>
              <span className="cart-action-ghost" aria-hidden="true">{children}</span>
              <LoaderCircle className="cart-action-spinner" size={16} aria-hidden="true" />
            </>
          ) : (
            children
          )}
        </span>
      </button>
    </form>
  );
}
