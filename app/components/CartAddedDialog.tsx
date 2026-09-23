import {useCallback, useEffect, useRef, useState} from 'react';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link, useLocation, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {
  PRODUCT_CONTENT,
  isPurchasableStatus,
  lineDisplayName,
  variantDisplayName,
} from '~/lib/product-content';
import type {ProductCardFragment, ProductVariantFragment} from '~/lib/product-shapes';
import {ShipChip, parcelPromise, shipChipText} from './ShipChip';
import {shippingQuote} from '~/lib/shipping-rates';
import {beginCartAdd, endCartAdd} from './cart-add-lock';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import {DATES_SEEN_FIELD, type CartSummary} from '~/lib/shopify-cart-action';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {
  CART_ADDED_EVENT,
  postCartAdd,
  storedShipCountry,
  type CartAddedDetail,
} from '~/lib/cart-client';

const CART_ACTION = '/api/shopify/cart';

function t(key: string, fallback: string, vars: Record<string, string> = {}): string {
  return (copyText(`cart.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

type CartLine = CartSummary['lines'][number];

/**
 * The size-matched partner board for a single FC or ESC line: the ESC for
 * an FC, the FC for an ESC, same mount size, sellable now and not in the
 * cart yet. Null for anything else.
 */
function stackPartner(
  line: CartLine | undefined,
  products: readonly ProductCardFragment[],
  cart: readonly CartLine[],
  sellable: (handle: string) => boolean,
): {label: string; variant: ProductVariantFragment} | null {
  const stack = line ? PRODUCT_CONTENT[line.handle]?.stack : undefined;
  if (!line || !stack || !line.variantTitle || line.variantTitle === 'Default Title') return null;
  const option = (stack.matchOption ?? 'Model').trim().toLowerCase();
  const size = line.variantTitle.trim().toLowerCase();
  for (const partner of stack.partners) {
    if (!sellable(partner.handle)) continue;
    const product = products.find((p) => p.handle === partner.handle);
    const variant = product?.variants.nodes.find(
      (v) =>
        v.availableForSale &&
        v.selectedOptions.some(
          (o) => o.name.trim().toLowerCase() === option && o.value.trim().toLowerCase() === size,
        ),
    );
    if (!product || !variant?.sku || cart.some((l) => l.sku === variant.sku)) continue;
    return {
      label: `${partner.label ?? product.title} ${variantDisplayName(product.handle, variant.title)}`,
      variant,
    };
  }
  return null;
}

/**
 * The drawer that opens after a background add to cart: the added line
 * with its ship chip, one optional stack row (FC <-> ESC, same size), the
 * subtotal and Checkout. One instance for the whole site, opened by the
 * `opendrone:cart-added` event every AddToCartButton sends.
 */
export function CartAddedDialog() {
  const rootData = useRouteLoaderData<RootLoader>('root');
  const revalidator = useRevalidator();
  const {pathname} = useLocation();
  const [detail, setDetail] = useState<CartAddedDetail | null>(null);
  const [summary, setSummary] = useState<CartSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // The stack SKU added from this drawer: it joins the added lines.
  const [stacked, setStacked] = useState<string | null>(null);
  // The destination picked in the cart, when the buyer picked one.
  const [shipCountry, setShipCountry] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setDetail(null);
    returnFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<CartAddedDetail>).detail;
      returnFocus.current = document.activeElement as HTMLElement | null;
      setDetail(next);
      setSummary(next.summary);
      setShipCountry(storedShipCountry());
      setStacked(null);
    };
    window.addEventListener(CART_ADDED_EVENT, open);
    return () => window.removeEventListener(CART_ADDED_EVENT, open);
  }, []);

  useEffect(() => {
    if (!detail) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      // Keep focus inside the modal: wrap from the last control to the first.
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detail, close]);

  // A navigation (View cart, a product link) closes the drawer.
  useEffect(() => setDetail(null), [pathname]);

  if (!detail || !summary) return null;

  // The lines added this time, with the stack partner once it is added here.
  const added = summary.lines
    .filter((l) => l.sku && (detail.skus.includes(l.sku) || l.sku === stacked))
    .sort((a, b) => Number(a.sku === stacked) - Number(b.sku === stacked));
  // One parcel per order: when the cart's lines ship at different times,
  // the drawer names the parcel's date above Checkout, as the cart does.
  const mixed = new Set(summary.lines.map((l) => l.shipPromise ?? '')).size > 1;
  const parcel = mixed
    ? shipChipText(parcelPromise(summary.lines.map((l) => l.shipPromise)), true)
    : null;
  const subtotal = summary.subtotal ?? null;
  // Same rule as the buy module and the cart: "incl. VAT" only where EU VAT
  // applies. The International and US markets keep the same price with no
  // EU VAT in it (Shopify: taxes included in price).
  const quote = shippingQuote(shipCountry ?? rootData?.visitorCountry ?? null);
  const vatIncluded = !quote || (!quote.blocked && quote.duty === 'none');
  const shipBlocked = quote?.blocked === true;

  // The stack row: judged on the cart as it was when the drawer opened; once
  // the partner is added here it shows as a line instead.
  const statuses = rootData?.productStatuses ?? {};
  const partner =
    added.length === 1
      ? stackPartner(added[0], rootData?.familyProducts ?? [], detail.summary.lines, (handle) =>
          isPurchasableStatus(statuses[handle]),
        )
      : null;

  const addStack = async () => {
    const sku = partner?.variant.sku;
    if (!partner || !sku || !beginCartAdd()) return;
    setBusy(true);
    try {
      setSummary(await postCartAdd(CART_ACTION, [['sku', sku], ['qty', '1']]));
      setStacked(sku);
      trackEvent('Stack Toggle', {
        props: {
          product: added[0]?.handle ?? 'unknown',
          partner: partner.variant.product.handle,
          surface: 'drawer',
          source: attributionSource(),
        },
      });
      void revalidator.revalidate();
    } catch {
      // The button stays; a second click tries again.
    } finally {
      endCartAdd();
      setBusy(false);
    }
  };

  return (
    <div className="cart-added-overlay" role="presentation">
      <button
        className="cart-added-scrim"
        type="button"
        tabIndex={-1}
        aria-label={t('added_close', 'Close')}
        onClick={close}
      />
      <section
        ref={dialogRef}
        className="cart-added"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-added-title"
      >
        <header className="cart-added-head">
          <h2 id="cart-added-title">
            <span className="cart-added-check" aria-hidden="true">
              ✓
            </span>{' '}
            {t('added_title', 'Added to cart')}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="cart-added-close"
            aria-label={t('added_close', 'Close')}
            onClick={close}
          >
            ×
          </button>
        </header>

        <ul className="cart-added-lines">
          {added.map((line) => (
            <li className="cart-added-line" key={line.sku}>
              {line.image ? (
                <img src={shopifyImageUrl(line.image.url, 112)} alt="" width={56} height={56} />
              ) : (
                <span className="cart-line-noimage" aria-hidden="true" />
              )}
              <div>
                <span className="cart-added-line-name">
                  {lineDisplayName(line.handle, line.title, line.variantTitle)}
                </span>
                {line.quantity > 1 && line.total ? (
                  <span className="cart-added-line-qty">
                    {`${line.quantity} × ${formatPrice(Number(line.total.amount) / line.quantity, line.total.currencyCode)}`}
                  </span>
                ) : null}
                <ShipChip promise={line.shipPromise} className="cart-added-ship" ifFunded />
              </div>
              {line.total ? (
                <span className="cart-added-price">
                  {formatPrice(line.total.amount, line.total.currencyCode)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        {partner && stacked !== partner.variant.sku ? (
          <p className="cart-added-stack">
            <span>
              {`${t('added_stack', 'Stack it:')} ${partner.label} · ${formatPrice(
                partner.variant.price.amount,
                partner.variant.price.currencyCode,
              )}`}
            </span>
            <button type="button" disabled={busy} onClick={() => void addStack()}>
              {t('added_stack_add', 'Add')}
            </button>
          </p>
        ) : null}

        <div className="cart-added-foot">
          {subtotal ? (
            <p className="cart-added-subtotal">
              <span>
                {vatIncluded
                  ? t('added_subtotal', 'Subtotal (incl. VAT)')
                  : t('added_subtotal_plain', 'Subtotal')}
              </span>
              <span className="cart-added-price">
                {formatPrice(subtotal.amount, subtotal.currencyCode)}
              </span>
            </p>
          ) : null}
          {parcel ? (
            <p className="cart-added-parcel">
              {`${t('mixed_one_parcel', 'One parcel')} · ${parcel.text}`}
            </p>
          ) : null}
          {shipBlocked ? null : (
            // A plain form post: the cart action checks every line again and
            // redirects to Shopify checkout, or back to /cart with a notice.
            <form
              method="post"
              action={CART_ACTION}
              onSubmit={() =>
                trackCheckoutClick(
                  subtotal ? {currency: subtotal.currencyCode, amount: Number(subtotal.amount)} : null,
                )
              }
            >
              <input type="hidden" name="intent" value="checkout" />
              {/* The parcel line above names the date, so checkout may go on. */}
              {parcel ? <input type="hidden" name={DATES_SEEN_FIELD} value="1" /> : null}
              <button type="submit" className="cart-added-checkout">
                {copyText('cart.checkout_cta') ?? 'Checkout'}
              </button>
            </form>
          )}
          <Link className="cart-added-viewcart" to="/cart" prefetch="intent">
            {t('added_view', 'View cart ({count})', {count: String(summary.totalQuantity)})}
          </Link>
        </div>
      </section>
    </div>
  );
}
