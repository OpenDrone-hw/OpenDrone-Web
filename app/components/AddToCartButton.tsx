import {useState, useSyncExternalStore} from 'react';
import {useRevalidator, useRouteLoaderData} from 'react-router';
import {LoaderCircle} from 'lucide-react';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionProps} from '~/lib/growth/attribution';
import {announceCartAdded, CartAddError, postCartAdd, skusFromFields, withCountry} from '~/lib/cart-client';
import {copyText} from '~/lib/copy';
import {countryName, notSoldDirect} from '~/lib/shipping-rates';
import type {RootLoader} from '~/root';
import {beginCartAdd, endCartAdd, isCartAddBusy, subscribeCartAdd} from './cart-add-lock';

/** What shows in place of a buy button for a visitor who cannot buy
 *  direct: outside the EU "EU consumer orders only", in an EU country not
 *  open yet "Orders are not open for Germany", in a blocked country "Not
 *  available in Russia". Null where the button shows. */
export function notSoldNote(country: string | null, usRate: number | null = null): string | null {
  const reason = notSoldDirect(country, usRate);
  if (reason === 'blocked') {
    return (copyText('product-chrome.buy_blocked') ?? 'Not available in {country}').replace(
      '{country}',
      countryName(country ?? ''),
    );
  }
  if (reason === 'shops') {
    return usRate != null
      ? (copyText('product-chrome.buy_shops_only_us') ?? 'EU and US consumer orders only')
      : (copyText('product-chrome.buy_shops_only') ?? 'EU consumer orders only');
  }
  if (reason === 'closed') {
    return (copyText('product-chrome.buy_closed') ?? 'Orders are not open for {country}').replace(
      '{country}',
      countryName(country ?? ''),
    );
  }
  return null;
}

/**
 * The buy button: a POST form to the cart action (`/api/shopify/cart`,
 * fields `sku`, `qty` or `lines`). With JavaScript it adds in the
 * background, the visitor stays on the page and the add-to-cart dialog
 * opens (`CartAddedDialog`); without it the form posts and lands on /cart.
 *
 * POST prevents crawlers and link previewers from creating carts by
 * following the public product link.
 *
 * A visitor from a country not sold direct (`notSoldDirect`) gets a plain
 * status line instead, on every surface that sells: product page, cards,
 * /preorder and the build suggestions.
 */
export function AddToCartButton({
  children,
  disabled,
  href,
  product,
  revenue,
  onClick,
  className = 'btn-primary',
  ariaLabel,
  dataTip,
  compactError = false,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  /** The hand-off link, from `buyUrl()` or a variant's `cartAddUrl`. */
  href: string;
  /** Low-cardinality product handle for the funnel events. */
  product?: string | null;
  /** Line value, so Plausible can attach revenue to the click. */
  revenue?: {currency: string; amount: number} | null;
  onClick?: () => void;
  /** Button class: defaults to the primary CTA; stack/quick-add
   *  surfaces pass their own compact pill styles. */
  className?: string;
  ariaLabel?: string;
  /** Attr-driven CSS tooltip content (see .pod-buy-stack[data-tip]). */
  dataTip?: string;
  /** Show a retryable failure in the button, without an extra message row. */
  compactError?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'adding' | 'error'>('idle');
  // Why the last add failed, in the buyer's words: the per-order limit
  // (400) or the paid-batch units left (409) come from the server.
  const [message, setMessage] = useState<string | null>(null);
  const revalidator = useRevalidator();
  // Another buy button's add is still running: this one waits, so two
  // quick taps never race on the cart and drop a line.
  const anyBusy = useSyncExternalStore(subscribeCartAdd, isCartAddBusy, () => false);
  const otherBusy = anyBusy && state !== 'adding';
  const rootData = useRouteLoaderData<RootLoader>('root');
  const note = notSoldNote(rootData?.visitorCountry ?? null, rootData?.usShippingRate ?? null);
  if (note) {
    return (
      <span className="buy-notsold" role="status">
        {note}
      </span>
    );
  }
  if (disabled) {
    return (
      <button
        type="button"
        disabled
        aria-label={ariaLabel}
        data-tip={dataTip}
        className={className}
      >
        <span className="btn-label">{children}</span>
      </button>
    );
  }

  const target = new URL(href, 'https://opendrone.be');
  const action = href.startsWith('http')
    ? `${target.origin}${target.pathname}`
    : target.pathname;
  const fields = Array.from(target.searchParams.entries());
  const fieldOccurrences = new Map<string, number>();
  const keyedFields = fields.map(([name, value]) => {
    const signature = `${name}:${value}`;
    const occurrence = (fieldOccurrences.get(signature) ?? 0) + 1;
    fieldOccurrences.set(signature, occurrence);
    return {name, value, key: `${signature}:${occurrence}`};
  });

  // Compact buttons (card quick-adds) never put a message line under
  // themselves: any failure, a refused quantity included, reads in the
  // button and the reason is its tooltip.
  const compactFailed = compactError && (state === 'error' || Boolean(message));

  return (
    <form
      action={action}
      method="post"
      className="add-to-cart-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (state === 'adding' || !beginCartAdd()) return;
        trackEvent('Add to Cart', {
          props: {
            product: product ?? 'unknown',
            sku: skusFromFields(fields).join('+') || 'unknown',
            ...attributionProps(),
          },
          ...(revenue && Number.isFinite(revenue.amount) ? {revenue} : {}),
        });
        // Drop focus after the click so :focus-within doesn't pin
        // hover-revealed quick-add UI open once the pointer leaves. A
        // keyboard press is remembered so the dialog can hand focus back.
        const button = e.currentTarget.querySelector('button');
        const returnFocus = button?.matches(':focus-visible') ? button : null;
        button?.blur();
        onClick?.();
        setState('adding');
        setMessage(null);
        // The destination this page shows (a `?country` override included)
        // goes with the add, so the cart is built for that market.
        const submitted = withCountry(
          keyedFields.map(({name, value}) => [name, value] as [string, string]),
          rootData?.visitorCountry ?? null,
        );
        postCartAdd(action, submitted)
          .then((summary) => {
            endCartAdd();
            setState('idle');
            announceCartAdded({summary, skus: skusFromFields(submitted), handle: product ?? null, returnFocus});
            // The first add creates the session cart: refresh the header's
            // cart link.
            void revalidator.revalidate();
          })
          .catch((caught: unknown) => {
            endCartAdd();
            const refused =
              caught instanceof CartAddError &&
              (caught.status === 400 || caught.status === 409) &&
              Boolean(caught.message) &&
              caught.message.length < 400;
            // A refused quantity fails the same way on a retry: keep the
            // label and say why. Anything else may pass on a second try.
            setState(refused ? 'idle' : 'error');
            setMessage(
              refused
                ? (caught as CartAddError).message
                : (copyText('cart.add_failed') ?? 'Could not add to cart. Try again in a minute.'),
            );
          });
      }}
    >
      {keyedFields.map(({name, value, key}) => (
        <input key={key} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        aria-label={ariaLabel}
        data-tip={dataTip}
        className={className}
        aria-busy={state === 'adding'}
        aria-disabled={otherBusy || undefined}
        data-waiting={otherBusy ? '' : undefined}
        data-state={compactFailed ? 'error' : state}
        title={compactFailed ? message ?? undefined : undefined}
      >
        {/* While adding, the button keeps its own label as an invisible
            placeholder, so it never changes size, and the spinner turns
            centred over it; "Adding…" is read out, not shown. */}
        <span
          className={`btn-label cart-action-label${state === 'adding' ? ' is-busy' : ''}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {state === 'adding' ? (
            <>
              <span className="cart-action-ghost" aria-hidden="true">{children}</span>
              <LoaderCircle className="cart-action-spinner" size={16} aria-hidden="true" />
              <span className="sr-only">{copyText('cart.add_busy') ?? 'Adding…'}</span>
            </>
          ) : compactFailed
              ? (copyText('cart.add_error_compact') ?? 'Couldn’t add. Retry')
              : state === 'error'
                ? (copyText('cart.add_retry') ?? 'Try again')
                : children}
        </span>
      </button>
      {message && !compactError ? (
        // The form is display: contents, so this sits in the buy row as its
        // own full-width item.
        <small className="cart-line-error" role="alert" style={{flex: '1 1 100%', width: '100%'}}>
          {message}
        </small>
      ) : null}
    </form>
  );
}
