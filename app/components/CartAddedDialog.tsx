import {useCallback, useEffect, useRef, useState} from 'react';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link, useLocation, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {Txt} from '~/components/Txt';
import {formatPrice} from '~/lib/catalog';
import {
  isPurchasableStatus,
  lineDisplayName,
  variantDisplayName,
} from '~/lib/product-content';
import {parcelPromise, soonerMonth} from './ShipChip';
import {LineShipChip, heldBy, parcelDelay} from './ParcelChip';
import {paysEuVat} from '~/lib/visitor-country';
import {countryName, notSoldDirect, shippingQuote} from '~/lib/shipping-rates';
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
import {DATES_SEEN_FIELD, latestDeliveryBy, type CartSummary} from '~/lib/shopify-cart-action';
import {trackEvent} from '~/lib/growth/plausible';
import {CART_ADDED_EVENT, postCartAdd, withCountry, type CartAddedDetail} from '~/lib/cart-client';
import {ShipToSelect} from './ShipToSelect';

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
  // every line shows the parcel's date, as the cart does.
  const mixed = new Set(summary.lines.map((l) => l.shipPromise ?? '')).size > 1;
  // Dated lines next to a funding-target line: the buyer can order the dated
  // ones separately to get them sooner (the cart page does the split).
  const sooner = mixed ? soonerMonth(summary.lines.map((l) => l.shipPromise)) : null;
  // The promise the whole parcel waits for: lines ready sooner say so.
  const parcelOf = mixed ? parcelPromise(summary.lines.map((l) => l.shipPromise)) : null;
  const parcelDeliveryBy = mixed ? latestDeliveryBy(summary.lines) : null;
  const subtotal = summary.subtotal ?? null;
  // Same rule as the buy module and the cart: "incl. VAT" only where EU VAT
  // applies.
  const visitor = rootData?.visitorCountry ?? null;
  const vatIncluded = paysEuVat(visitor);
  // The same destination availability gate as the product and cart.
  const usRate = rootData?.usShippingRate ?? null;
  const notDirect = notSoldDirect(visitor, usRate);
  // A US buyer: every line carries the US delivery notice.
  const usBuyer = usRate != null && visitor === 'US';
  // The flat rate, shown before Shopify (see the cart).
  const quote = shippingQuote(visitor, undefined, usRate);
  const shippingRate =
    quote?.kind === 'direct' && quote.rate !== null ? formatPrice(quote.rate, quote.zone === 'us' ? 'USD' : 'EUR') : null;
  const cartPromises = summary.lines.map((l) => l.shipPromise);

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
      setSummary(
        await postCartAdd(
          CART_ACTION,
          withCountry([['sku', part.sku], ['qty', String(part.quantity)]], visitor),
        ),
      );
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
                <LineShipChip promise={line.shipPromise} parcel={parcelOf} className="cart-added-ship" />
                {parcelDeliveryBy || line.deliveryBy ? (
                  <small className="cart-added-line-qty">{t('delivery_by', 'Delivery by {date}', {date: parcelDeliveryBy ?? line.deliveryBy!})}</small>
                ) : null}
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
                // A part that ships later than the parcel moves the whole parcel.
                const delay = inCart ? null : parcelDelay(cartPromises, part.variant.shipPromise);
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
                      {/* What this part would actually do in this cart: an
                          earlier one ships with the parcel, on its date. */}
                      <LineShipChip
                        promise={part.variant.shipPromise}
                        parcel={inCart ? null : heldBy(cartPromises, part.variant.shipPromise)}
                        className="cart-added-ship"
                      />
                      {delay ? (
                        <small className="cart-added-delay" role="note">
                          {t('upsell_delay', 'Adding this delays your whole parcel: instead of {from} it ships {to}.', delay)}
                        </small>
                      ) : null}
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
          <ShipToSelect
            country={visitor}
            usRate={usRate}
            className="ship-to cart-added-ship-to"
            onChanged={(reply) => {
              if (reply.summary) setSummary(reply.summary);
            }}
          />
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
          {shippingRate ? (
            <p className="cart-added-subtotal">
              <span>{t('shipping_row', 'Shipping to {country}', {country: countryName(visitor ?? '')})}</span>
              <span className="cart-added-price">{shippingRate}</span>
            </p>
          ) : null}
          {usBuyer && subtotal?.currencyCode === 'USD' ? (
            <p className="cart-added-parcel">{t('us_price_note', 'Duties included')}</p>
          ) : null}
          {quote?.kind === 'direct' && quote.zone === 'international' ? (
            <p className="cart-added-parcel">{t('international_note', 'Shipping and applicable sale taxes are confirmed at checkout. Import duties, import taxes and customs handling charges may be payable on delivery.')}</p>
          ) : null}
          {sooner ? (
            <p className="cart-added-parcel">
              <Link to="/cart" className="cart-added-split">
                {t('split_dialog_link', 'Want the {month} items sooner? Order them separately in your cart.', {month: sooner})}
              </Link>
            </p>
          ) : null}
          {/* Checkout is a plain form post: the cart action checks every line
              again and redirects to Shopify checkout, or back to /cart with
              a notice. */}
          {notDirect === 'blocked' ? (
            <p className="cart-added-parcel" role="note">
              {t('checkout_blocked', 'Not available in {country}.', {country: countryName(visitor ?? '')})}{' '}
              <Link to="/end-use">{t('checkout_blocked_link', 'End-Use Policy')}</Link>
            </p>
          ) : notDirect === 'shops' ? (
            <p className="cart-added-parcel" role="note">
              {t('checkout_shops', 'Consumer checkout is not available for this destination.', {country: countryName(visitor ?? '')})}{' '}
              <Link to="/wholesale">{t('checkout_shops_trade', 'EU or US retailer enquiries')}</Link>
              {' · '}
              <Link to="/newsletter">{t('checkout_shops_notify', 'Get launch news')}</Link>
            </p>
          ) : notDirect === 'closed' ? (
            <p className="cart-added-parcel" role="note">
              {t('checkout_closed', 'Orders are not open for {country}.', {country: countryName(visitor ?? '')})}{' '}
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
              {visitor ? <input type="hidden" name="country" value={visitor} /> : null}
              {/* Every line names its date, so checkout may go on. */}
              {mixed ? <input type="hidden" name={DATES_SEEN_FIELD} value="1" /> : null}
              <button type="submit" className="cart-added-checkout">
                {copyText('cart.checkout_cta') ?? 'Checkout'}
              </button>
            </form>
          )}
          <Link className="cart-added-viewcart" to="/cart" prefetch="intent">
            {t('added_view', 'View cart ({count})', {count: String(summary.totalQuantity)})}
          </Link>
          <Txt id="cart.note_terms" as="p" className="cart-added-parcel [&_a]:underline! [&_a]:underline-offset-4" />
        </div>
      </section>
    </div>
  );
}
