import {useEffect, useRef, useState} from 'react';
import {Link, useFetcher, useRouteLoaderData} from 'react-router';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import type {ShopifyCart} from '~/lib/shopify-storefront';
import type {ProductCardFragment} from '~/lib/product-shapes';
import {resolveBuildSuggestions} from '~/lib/build-recommendations';

/**
 * A regular POST form that adds one or more catalog lines to the active cart.
 *
 * POST prevents crawlers and link previewers from creating quotations by
 * following the public product link. The click still fires funnel events
 * before the browser navigates to the cart review page.
 */
export function AddToCartButton({
  children,
  disabled,
  href,
  product,
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
  const fetcher = useFetcher();
  const companionFetcher = useFetcher();
  const recommendationFetcher = useFetcher<{handles?: string[]}>();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submittedSuggestion, setSubmittedSuggestion] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootData = useRouteLoaderData('root') as
    | {familyProducts?: ProductCardFragment[]}
    | undefined;
  useEffect(() => {
    if (submitted && fetcher.state === 'idle' && fetcher.data) {
      setSubmitted(false);
      setConfirmationOpen(true);
      window.dispatchEvent(new CustomEvent('opendrone:cart-updated', {
        detail: {totalQuantity: (fetcher.data as ShopifyCart).totalQuantity},
      }));
    }
  }, [fetcher.data, fetcher.state, submitted]);
  useEffect(() => {
    if (!confirmationOpen) return;
    closeRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmationOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [confirmationOpen]);
  useEffect(() => {
    if (!companionFetcher.data || companionFetcher.state !== 'idle') return;
    window.dispatchEvent(new CustomEvent('opendrone:cart-updated', {
      detail: {totalQuantity: (companionFetcher.data as ShopifyCart).totalQuantity},
    }));
  }, [companionFetcher.data, companionFetcher.state]);
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
  const sourceSku = fields.find(([name]) => name === 'sku')?.[1];
  const cart = fetcher.data as ShopifyCart | undefined;
  const addedLine = cart?.lines.find((line) => line.sku === sourceSku);
  const suggestions = resolveBuildSuggestions(
    rootData?.familyProducts ?? [],
    product,
    sourceSku,
    recommendationFetcher.data?.handles ?? [],
  );

  return (
    <>
    <fetcher.Form
      action={action}
      method="post"
      className="add-to-cart-form"
      onSubmit={(e) => {
        trackEvent('Add to Cart', {
          props: {product: product ?? 'unknown', source: attributionSource()},
        });
        setSubmitted(true);
        if (product) {
          void recommendationFetcher.load(
            `/api/shopify/recommendations?handle=${encodeURIComponent(product)}`,
          );
        }
        // Drop focus after the click so :focus-within doesn't pin
        // hover-revealed quick-add UI open once the pointer leaves.
        e.currentTarget.querySelector('button')?.blur();
        onClick?.();
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
        disabled={fetcher.state !== 'idle'}
      >
        <span className="btn-label">{fetcher.state === 'idle' ? children : 'Adding…'}</span>
      </button>
    </fetcher.Form>
    {confirmationOpen ? (
      <div className="cart-confirmation-overlay" role="presentation">
        <button className="cart-confirmation-scrim" type="button" aria-label="Close cart confirmation" onClick={() => setConfirmationOpen(false)} />
        <section className="cart-confirmation" role="dialog" aria-modal="true" aria-labelledby="cart-confirmation-title">
          <button ref={closeRef} type="button" className="cart-confirmation-close" aria-label="Close" onClick={() => setConfirmationOpen(false)}>×</button>
          <div className="cart-confirmation-added">
            <span aria-hidden="true">✓</span>
            <div>
              <p className="cart-confirmation-eyebrow">Added to cart</p>
              <h2 id="cart-confirmation-title">Your item is in the cart</h2>
            </div>
          </div>
          {addedLine ? (
            <div className="cart-confirmation-product">
              {addedLine.image ? <img src={addedLine.image.url} alt={addedLine.image.altText ?? addedLine.title} width={92} height={92} /> : null}
              <div>
                <strong>{addedLine.title}</strong>
                <span>{addedLine.variantTitle}</span>
              </div>
              <strong>{addedLine.quantity > 1 ? `× ${addedLine.quantity}` : ''}</strong>
            </div>
          ) : null}
          {suggestions.length ? (
            <div className="cart-confirmation-suggestion">
              <p>Complete your build</p>
              <div className="cart-confirmation-suggestions">
              {suggestions.map((suggestion) => {
                const image = suggestion.variant.image ?? suggestion.product.featuredImage;
                const added = companionFetcher.data && submittedSuggestion === suggestion.sku;
                return <div className="cart-confirmation-companion" key={suggestion.sku}>
                  {image ? <img src={image.url} alt={image.altText ?? suggestion.product.title} width={104} height={104} /> : null}
                  <div>
                    <strong>{suggestion.quantity > 1 ? `${suggestion.quantity}× ` : ''}{suggestion.product.title}</strong>
                    <span>{suggestion.variant.title}</span>
                    <small>€{(Number(suggestion.variant.price.amount) * suggestion.quantity).toFixed(2)}</small>
                  </div>
                  <companionFetcher.Form action="/api/shopify/cart" method="post" onSubmit={() => {
                    setSubmittedSuggestion(suggestion.sku);
                    trackEvent('Recommendation Add', {
                      props: {
                        product: suggestion.product.handle,
                        source_product: product ?? 'unknown',
                        role: suggestion.role,
                        strategy: recommendationFetcher.data?.handles?.includes(
                          suggestion.product.handle,
                        ) ? 'shopify-complementary' : 'compatibility',
                      },
                    });
                  }}>
                    <input type="hidden" name="sku" value={suggestion.sku} />
                    <input type="hidden" name="qty" value={suggestion.quantity} />
                    <button className="btn-secondary" type="submit" disabled={companionFetcher.state !== 'idle'}>
                      {added ? 'Added' : companionFetcher.state !== 'idle' && submittedSuggestion === suggestion.sku ? 'Adding…' : 'Add'}
                    </button>
                  </companionFetcher.Form>
                </div>;
              })}
              </div>
            </div>
          ) : null}
          <div className="cart-confirmation-actions">
            <button type="button" className="btn-secondary" onClick={() => setConfirmationOpen(false)}>Continue shopping</button>
            <Link className="btn-primary" to="/cart">View cart</Link>
          </div>
        </section>
      </div>
    ) : null}
    </>
  );
}
