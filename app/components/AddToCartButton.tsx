import {useState} from 'react';
import {useRevalidator} from 'react-router';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {announceCartAdded, CartAddError, postCartAdd, skusFromFields} from '~/lib/cart-client';
import {copyText} from '~/lib/copy';

/**
 * The buy button: a POST form to the cart action (`/api/shopify/cart`,
 * fields `sku`, `qty` or `lines`). With JavaScript it adds in the
 * background, the visitor stays on the page and the add-to-cart dialog
 * opens (`CartAddedDialog`); without it the form posts and lands on /cart.
 *
 * POST prevents crawlers and link previewers from creating carts by
 * following the public product link.
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
}) {
  const [state, setState] = useState<'idle' | 'adding' | 'error'>('idle');
  // Why the last add failed, in the buyer's words: the per-order limit
  // (400) or the paid-batch units left (409) come from the server.
  const [message, setMessage] = useState<string | null>(null);
  const revalidator = useRevalidator();
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

  return (
    <form
      action={action}
      method="post"
      className="add-to-cart-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (state === 'adding') return;
        trackEvent('Add to Cart', {
          props: {product: product ?? 'unknown', source: attributionSource()},
          ...(revenue && Number.isFinite(revenue.amount) ? {revenue} : {}),
        });
        // Drop focus after the click so :focus-within doesn't pin
        // hover-revealed quick-add UI open once the pointer leaves.
        e.currentTarget.querySelector('button')?.blur();
        onClick?.();
        setState('adding');
        setMessage(null);
        const submitted = keyedFields.map(({name, value}) => [name, value] as [string, string]);
        postCartAdd(action, submitted)
          .then((summary) => {
            setState('idle');
            announceCartAdded({summary, skus: skusFromFields(submitted), handle: product ?? null});
            // The first add creates the session cart: refresh the header's
            // cart link.
            void revalidator.revalidate();
          })
          .catch((caught: unknown) => {
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
      >
        <span className="btn-label">
          {state === 'adding' ? 'Adding…' : state === 'error' ? 'Try again' : children}
        </span>
      </button>
      {message ? (
        // The form is display: contents, so this sits in the buy row as its
        // own full-width item.
        <small className="cart-line-error" role="alert" style={{flex: '1 1 100%', width: '100%'}}>
          {message}
        </small>
      ) : null}
    </form>
  );
}
