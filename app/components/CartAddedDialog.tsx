import {LoaderCircle} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link, useLocation, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {Txt} from '~/components/Txt';
import {formatPrice} from '~/lib/catalog';
import {EarlyBirdNote, useAnyEarlySku} from '~/components/EarlyPriceCue';
import {
  isPurchasableStatus,
  lineDisplayName,
  variantDisplayName,
} from '~/lib/product-content';
import {ShipChip, parcelPromise, soonerMonth} from './ShipChip';
import {LineShipChip, heldBy, parcelDelay} from './ParcelChip';
import {paysEuVat} from '~/lib/visitor-country';
import {countryName, notSoldDirect, offersPickup, shippingQuote} from '~/lib/shipping-rates';
import {
  buildSuggestionSpecs,
  extraSuggestionSpecs,
  parseBuilds,
  resolveBuild,
  resolveBuildSuggestions,
  type BuildSuggestion,
} from '~/lib/build-recommendations';
import buildsJson from '../../content/builds.json';
import {beginCartAdd, endCartAdd} from './cart-add-lock';
import {BuildBundle, bundleFields} from './BuildBundle';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import {DATES_SEEN_FIELD, hasMixedShipGroups, latestDeliveryBy, type CartSummary} from '~/lib/shopify-cart-action';
import {trackEvent} from '~/lib/growth/plausible';
import {CART_ADDED_EVENT, postCartAdd, withCountry, type CartAddedDetail} from '~/lib/cart-client';
import {ShipToSelect} from './ShipToSelect';
import '../styles/cart-checkout-bar.css';

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
      const active = document.activeElement as HTMLElement | null;
      returnFocus.current = next.returnFocus ?? (active && active !== document.body ? active : null);
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

  // The page behind stays put while the drawer is open. The lock goes on
  // <html>: its overflow-x clip keeps a body lock from reaching the viewport.
  const open = detail !== null;
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const prevRoot = root.style.overflow;
    const prevBody = document.body.style.overflow;
    root.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      root.style.overflow = prevRoot;
      document.body.style.overflow = prevBody;
    };
  }, [open]);

  // A navigation (View cart, a product link) closes the drawer.
  useEffect(() => setDetail(null), [pathname]);
  const anyEarly = useAnyEarlySku(summary?.lines.map((l) => l.sku) ?? []);

  if (!detail || !summary) return null;

  // The lines added this time.
  const added = summary.lines.filter((l) => l.sku && detail.skus.includes(l.sku));
  // One parcel per order: when the cart's lines ship at different times,
  // the drawer says so, as the cart does. Checkout's own rule: lines waiting
  // for different funding targets are mixed even when their dates read the
  // same, so checkout never sends the buyer back to the cart unannounced.
  const mixed = hasMixedShipGroups(summary.lines);
  // Dated lines next to a funding-target line: the buyer can order the dated
  // ones separately to get them sooner (the cart page does the split).
  const sooner = mixed ? soonerMonth(summary.lines.map((l) => l.shipPromise)) : null;
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
  // International: the rate Shopify checkout starts from, when the add could
  // compute it for this cart (`international-shipping.ts`).
  const internationalFrom =
    quote?.kind === 'direct' && quote.zone === 'international' && summary.shippingFrom?.country === quote.country
      ? summary.shippingFrom
      : null;
  const cartPromises = summary.lines.map((l) => l.shipPromise);
  const orderPromise = parcelPromise(cartPromises) ?? cartPromises.find(Boolean) ?? null;
  const orderDeliveryBy = latestDeliveryBy(summary.lines);

  // The parts that complete the build, judged on the cart as it was when
  // the drawer opened, so a part added from here stays listed as "Added".
  const openedWith = detail.summary.lines;
  const statuses = rootData?.productStatuses ?? {};
  const buildId = resolveBuild(BUILDS, detail.skus[0], openedWith.map((l) => l.sku));
  const buildLabel = BUILDS.builds.find((b) => b.id === buildId)?.label ?? null;
  const parts = resolveBuildSuggestions(
    rootData?.familyProducts ?? [],
    buildSuggestionSpecs(BUILDS, buildId, openedWith),
    (handle) => isPurchasableStatus(statuses[handle]),
  );
  // The rest of the quad, offered closed; props count as an add-on.
  const suggestions = parts.filter((p) => p.role !== 'props');
  // Cheap add-ons for what the cart holds, the build's props first. One
  // that ships later than the cart is left out: it would hold the whole
  // parcel back.
  const openedPromises = openedWith.map((l) => l.shipPromise);
  const extras = [
    ...parts.filter((p) => p.role === 'props'),
    ...resolveBuildSuggestions(
      rootData?.familyProducts ?? [],
      extraSuggestionSpecs(BUILDS, openedWith, parts.map((s) => s.sku)),
      (handle) => isPurchasableStatus(statuses[handle]),
    ),
  ]
    .filter((part) => !parcelDelay(openedPromises, part.variant.shipPromise))
    .slice(0, 3);

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
          strategy: part.role === 'extra' ? 'accessory' : 'compatibility',
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

  // Parts already in the cart (added from here, say) leave the bundle.
  const bundle = suggestions.filter((p) => !summary.lines.some((l) => l.sku === p.sku));
  const addBundle = async () => {
    if (!bundle.length || !beginCartAdd()) return;
    setBusy('bundle');
    setFailed(null);
    try {
      setSummary(await postCartAdd(CART_ACTION, withCountry(bundleFields(bundle), visitor)));
      trackEvent('Recommendation Add', {
        props: {
          product: bundle.map((p) => p.handle).join(','),
          source_product: detail.handle ?? 'unknown',
          role: 'bundle',
          strategy: 'compatibility',
        },
      });
      void revalidator.revalidate();
    } catch {
      setFailed('bundle');
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
              </div>
              {line.total ? (
                <span className="cart-added-price">
                  {formatPrice(line.total.amount, line.total.currencyCode)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        {(
          [
            // The cheap add-ons first: one tap, and they never fall below
            // a long build list.
            ['extras', t('extras_title', 'Add-ons'), extras],
          ] as const
        ).map(([group, title, parts]) => parts.length ? (
          <Group key={group} title={title}>
            <ul className="cart-added-suggestions">
              {parts.map((part) => {
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
                      aria-busy={busy === part.sku || undefined}
                      onClick={() => void addPart(part)}
                    >
                      {busy === part.sku ? (
                        <span className="cart-action-label">
                          <LoaderCircle className="cart-action-spinner" size={14} aria-hidden="true" />
                          <span className="sr-only">{t('add_busy', 'Adding…')}</span>
                        </span>
                      ) : inCart
                        ? t('build_added', 'Added')
                        : failed === part.sku
                          ? t('build_retry', 'Try again')
                          : t('build_add', 'Add')}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Group>
        ) : null)}
        {/* The rest of the quad: one card, one button for every part. */}
        <BuildBundle
          parts={bundle}
          label={buildLabel}
          cartPromises={cartPromises}
          busy={busy === 'bundle'}
          failed={failed === 'bundle'}
          onAdd={() => void addBundle()}
        />

        <div className="cart-added-foot">
          <ShipToSelect
            country={visitor}
            usRate={usRate}
            className="ship-to cart-added-ship-to"
            onChanged={(reply) => {
              if (reply.summary) setSummary(reply.summary);
            }}
          />
          {subtotal && notDirect ? (
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
          {subtotal ? <EarlyBirdNote show={anyEarly} className="cart-added-parcel" /> : null}
          {shippingRate ? (
            <p className="cart-added-subtotal">
              <span>{t('shipping_row', 'Shipping to {country}', {country: countryName(visitor ?? '')})}</span>
              <span className="cart-added-price">{shippingRate}</span>
            </p>
          ) : internationalFrom ? (
            <p className="cart-added-subtotal">
              <span>{t('shipping_row', 'Shipping to {country}', {country: countryName(visitor ?? '')})}</span>
              <span className="cart-added-from">
                {t('shipping_from', 'from {price}, confirmed at checkout', {price: formatPrice(internationalFrom.amount, internationalFrom.currencyCode)})}
              </span>
            </p>
          ) : null}
          {/* The order's one ship and delivery date, said once. */}
          {orderPromise || orderDeliveryBy ? (
            <div className="cart-added-subtotal cart-added-when">
              <span>{t('parcel_label', 'Your parcel')}</span>
              <span className="cart-parcel-when">
                <ShipChip promise={orderPromise} ifFunded />
                {orderDeliveryBy ? <small>{t('delivery_by', 'Delivery by {date}', {date: orderDeliveryBy})}</small> : null}
              </span>
            </div>
          ) : null}
          {shippingRate && offersPickup(visitor) ? (
            <p className="cart-added-parcel">{t('pickup_note', 'Or pick up free at our Leuven office: choose Pickup at checkout.')}</p>
          ) : null}
          {usBuyer && subtotal?.currencyCode === 'USD' ? (
            <p className="cart-added-parcel">{t('us_price_note', 'Duties included')}</p>
          ) : null}
          {quote?.kind === 'direct' && quote.zone === 'international' ? (
            <p className="cart-added-parcel">{t('international_note', 'Shipping and applicable sale taxes are confirmed at checkout. Import duties, import taxes and customs handling charges may be payable on delivery.')}</p>
          ) : null}
          {mixed ? (
            <p className="cart-added-parcel" role="note">{t('parcel_note', 'Your order ships in one parcel, when its last item is ready.')}</p>
          ) : null}
          {sooner ? (
            <p className="cart-added-parcel">
              <Link to="/cart" className="cart-added-split">
                {t('split_dialog_link', 'Want the {month} items sooner? Order them separately in your cart.', {month: sooner})}
              </Link>
            </p>
          ) : null}
          {/* No consumer checkout here: say why. Otherwise Checkout is the
              bar below, a plain form post: the cart action checks every line
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
              {', '}
              <Link to="/newsletter">{t('checkout_shops_notify', 'Get launch news')}</Link>
            </p>
          ) : notDirect === 'closed' ? (
            <p className="cart-added-parcel" role="note">
              {t('checkout_closed', 'Orders are not open for {country}.', {country: countryName(visitor ?? '')})}{' '}
              <Link to="/newsletter">{t('checkout_shops_notify', 'Get launch news')}</Link>
            </p>
          ) : null}
          <Link className="cart-added-viewcart" to="/cart" prefetch="intent">
            {t('added_view', 'View cart ({count})', {count: String(summary.totalQuantity)})}
          </Link>
          <Txt id="cart.note_terms" as="p" className="cart-added-parcel [&_a]:underline! [&_a]:underline-offset-4" />
        </div>
        {/* Subtotal, the parcel's date and Checkout stay pinned to the
            bottom of the drawer, however long the suggestions above run. */}
        {notDirect ? null : (
          <form
            className="cart-added-bar"
            method="post"
            action={CART_ACTION}
            onSubmit={() => trackCheckoutClick(subtotal, 'dialog')}
          >
            <input type="hidden" name="intent" value="checkout" />
            {visitor ? <input type="hidden" name="country" value={visitor} /> : null}
            {/* The drawer shows the one-parcel line, so checkout may go on. */}
            {mixed ? <input type="hidden" name={DATES_SEEN_FIELD} value="1" /> : null}
            <div className="cart-bar-sum">
              {subtotal ? (
                <span className="cart-bar-total">
                  {formatPrice(subtotal.amount, subtotal.currencyCode)}
                  <small>{vatIncluded ? t('added_subtotal', 'Subtotal (incl. VAT)') : t('added_subtotal_plain', 'Subtotal')}</small>
                </span>
              ) : null}
              <ShipChip promise={orderPromise} ifFunded className="cart-bar-ship" />
            </div>
            <button type="submit" className="cart-added-checkout cart-bar-checkout">
              {copyText('cart.checkout_cta') ?? 'Checkout'}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

/** One open suggestion group under its title (the add-ons). */
function Group({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="cart-added-build cart-added-addons">
      <p className="cart-added-build-title">{title}</p>
      {children}
    </div>
  );
}
