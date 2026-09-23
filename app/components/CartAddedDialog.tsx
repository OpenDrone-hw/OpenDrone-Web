import {useCallback, useEffect, useRef, useState} from 'react';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link, useLocation, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {
  isPurchasableStatus,
  lineDisplayName,
  variantDisplayName,
} from '~/lib/product-content';
import {ShipChip, parcelPromise, shipChipText} from './ShipChip';
import {paysEuVat} from '~/lib/visitor-country';
import {countryName, soldThroughShops} from '~/lib/shipping-rates';
import {
  buildSuggestionSpecs,
  parseBuilds,
  resolveBuild,
  resolveBuildSuggestions,
  type BuildSuggestion,
} from '~/lib/build-recommendations';
import buildsJson from '../../content/builds.json';
import {beginCartAdd, endCartAdd} from './cart-add-lock';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import {DATES_SEEN_FIELD, type CartSummary} from '~/lib/shopify-cart-action';
import {trackEvent} from '~/lib/growth/plausible';
import {CART_ADDED_EVENT, postCartAdd, type CartAddedDetail} from '~/lib/cart-client';

const CART_ACTION = '/api/shopify/cart';
const BUILDS = parseBuilds(buildsJson);

function t(key: string, fallback: string, vars: Record<string, string> = {}): string {
  return (copyText(`cart.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * The drawer that opens after a background add to cart: the added line
 * with its ship chip, the parts that complete the same build as compact
 * rows with an Add button each, the subtotal and Checkout. One instance
 * for the whole site, opened by the `opendrone:cart-added` event every
 * AddToCartButton sends. Shipping is priced at Shopify checkout only.
 */
export function CartAddedDialog() {
  const rootData = useRouteLoaderData<RootLoader>('root');
  const revalidator = useRevalidator();
  const {pathname} = useLocation();
  const [detail, setDetail] = useState<CartAddedDetail | null>(null);
  const [summary, setSummary] = useState<CartSummary | null>(null);
  // The suggestion SKU being added, and the one whose add failed.
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
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
      setFailed(null);
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

  // The lines added this time.
  const added = summary.lines.filter((l) => l.sku && detail.skus.includes(l.sku));
  // One parcel per order: when the cart's lines ship at different times,
  // the drawer names the parcel's date above Checkout, as the cart does.
  const mixed = new Set(summary.lines.map((l) => l.shipPromise ?? '')).size > 1;
  const parcel = mixed
    ? shipChipText(parcelPromise(summary.lines.map((l) => l.shipPromise)), true)
    : null;
  const subtotal = summary.subtotal ?? null;
  // Same rule as the buy module and the cart: "incl. VAT" only where EU VAT
  // applies.
  const visitor = rootData?.visitorCountry ?? null;
  const vatIncluded = paysEuVat(visitor);
  // Outside the EU checkout is not offered, as in the cart.
  const throughShops = soldThroughShops(visitor);

  // The parts that complete the build, judged on the cart as it was when
  // the drawer opened, so a part added from here stays listed as "Added".
  const openedWith = detail.summary.lines;
  const statuses = rootData?.productStatuses ?? {};
  const suggestions = resolveBuildSuggestions(
    rootData?.familyProducts ?? [],
    buildSuggestionSpecs(
      BUILDS,
      resolveBuild(BUILDS, detail.skus[0], openedWith.map((l) => l.sku)),
      openedWith,
    ),
    (handle) => isPurchasableStatus(statuses[handle]),
  );

  const addPart = async (part: BuildSuggestion) => {
    if (!beginCartAdd()) return;
    setBusy(part.sku);
    setFailed(null);
    try {
      setSummary(await postCartAdd(CART_ACTION, [['sku', part.sku], ['qty', String(part.quantity)]]));
      trackEvent('Recommendation Add', {
        props: {
          product: part.handle,
          source_product: detail.handle ?? 'unknown',
          role: part.role,
          strategy: 'compatibility',
        },
      });
      void revalidator.revalidate();
    } catch {
      setFailed(part.sku);
    } finally {
      endCartAdd();
      setBusy(null);
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

        {suggestions.length ? (
          <div className="cart-added-build">
            <p className="cart-added-build-title">{t('build_title', 'Complete the build')}</p>
            <ul className="cart-added-suggestions">
              {suggestions.map((part) => {
                const image = part.variant.image ?? part.product.featuredImage;
                const inCart = summary.lines.some((l) => l.sku === part.sku);
                return (
                  <li className="cart-added-suggestion" key={part.sku}>
                    {image ? (
                      <img src={shopifyImageUrl(image.url, 96)} alt="" width={48} height={48} loading="lazy" />
                    ) : (
                      <span className="cart-line-noimage" aria-hidden="true" />
                    )}
                    <div>
                      <span className="cart-added-suggestion-name">
                        {part.quantity > 1 ? `${part.quantity}x ` : ''}
                        {part.variant.title !== 'Default Title'
                          ? `${part.product.title} ${variantDisplayName(part.product.handle, part.variant.title)}`
                          : part.product.title}
                      </span>
                      <ShipChip promise={part.variant.shipPromise} className="cart-added-ship" />
                    </div>
                    <span className="cart-added-price">
                      {formatPrice(
                        Number(part.variant.price.amount) * part.quantity,
                        part.variant.price.currencyCode,
                      )}
                    </span>
                    <button
                      type="button"
                      className="cart-added-add"
                      disabled={inCart || busy !== null}
                      onClick={() => void addPart(part)}
                    >
                      {inCart
                        ? t('build_added', 'Added')
                        : failed === part.sku
                          ? t('build_retry', 'Try again')
                          : t('build_add', 'Add')}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
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
          {/* Checkout is a plain form post: the cart action checks every line
              again and redirects to Shopify checkout, or back to /cart with
              a notice. */}
          {throughShops ? (
            <p className="cart-added-parcel" role="note">
              {t('checkout_shops', 'Available through shops in {country}.', {country: countryName(visitor ?? '')})}{' '}
              <Link to="/wholesale">{t('checkout_shops_trade', 'Are you a shop?')}</Link>
              {' · '}
              <Link to="/newsletter">{t('checkout_shops_notify', 'Get launch news')}</Link>
            </p>
          ) : (
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
