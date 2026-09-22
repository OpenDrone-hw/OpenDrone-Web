import {useCallback, useEffect, useRef, useState} from 'react';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link, useLocation, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {Txt} from '~/components/Txt';
import {formatPrice} from '~/lib/catalog';
import {isInternalSku, isPurchasableStatus, variantDisplayName} from '~/lib/product-content';
import {countryName, shippingQuote} from '~/lib/shipping-rates';
import {beginCartAdd, endCartAdd} from './cart-add-lock';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import type {CartSummary} from '~/lib/shopify-cart-action';
import {trackEvent} from '~/lib/growth/plausible';
import {
  CART_ADDED_EVENT,
  postCartAdd,
  storedShipCountry,
  type CartAddedDetail,
} from '~/lib/cart-client';
import {
  buildSuggestionSpecs,
  extraSuggestionSpecs,
  parseBuilds,
  resolveBuild,
  resolveBuildSuggestions,
  type BuildSuggestion,
} from '~/lib/build-recommendations';
import buildsJson from '../../content/builds.json';

const CART_ACTION = '/api/shopify/cart';
const BUILDS = parseBuilds(buildsJson);

function t(key: string, fallback: string, vars: Record<string, string> = {}): string {
  return (copyText(`cart.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/**
 * The dialog that opens after a background add to cart: what went in, and
 * the parts that complete the same build. One instance for the whole site,
 * opened by the `opendrone:cart-added` event every AddToCartButton sends.
 *
 * Suggestions come from the build graph (hard compatibility), ranked by
 * Shopify's complementary products, minus what the cart already holds and
 * anything the shop cannot sell right now. A part that ships on another
 * date than the cart says so, because the whole order then waits for it.
 */
export function CartAddedDialog() {
  const rootData = useRouteLoaderData<RootLoader>('root');
  const revalidator = useRevalidator();
  const {pathname} = useLocation();
  const [detail, setDetail] = useState<CartAddedDetail | null>(null);
  const [summary, setSummary] = useState<CartSummary | null>(null);
  const [ranking, setRanking] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
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
      setFailed(null);
      setRanking([]);
      if (next.handle) {
        fetch(`/api/shopify/recommendations?handle=${encodeURIComponent(next.handle)}`)
          .then((r) => (r.ok ? (r.json() as Promise<{handles?: string[]}>) : {handles: []}))
          .then((d) => setRanking(d.handles ?? []))
          .catch(() => {});
      }
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

  // A navigation (View cart, a product link) closes the dialog.
  useEffect(() => setDetail(null), [pathname]);

  if (!detail || !summary) return null;

  // The build is judged on the cart as it was when the dialog opened, so a
  // part added from here stays listed as "Added" instead of vanishing.
  const openedWith = detail.summary.lines;
  const buildId = resolveBuild(BUILDS, detail.skus[0], openedWith.map((l) => l.sku));
  const build = BUILDS.builds.find((b) => b.id === buildId);
  const statuses = rootData?.productStatuses ?? {};
  const suggestions = resolveBuildSuggestions(
    rootData?.familyProducts ?? [],
    buildSuggestionSpecs(BUILDS, buildId, openedWith, ranking),
    (handle) => isPurchasableStatus(statuses[handle]),
  );
  const extras = resolveBuildSuggestions(
    rootData?.familyProducts ?? [],
    extraSuggestionSpecs(BUILDS, openedWith),
    (handle) => isPurchasableStatus(statuses[handle]),
  );
  const added = summary.lines.filter((l) => l.sku && detail.skus.includes(l.sku));
  const subtotal = summary.subtotal ?? null;
  // Same rule as the buy module: "incl. VAT" only where EU VAT applies.
  const quote = shippingQuote(shipCountry ?? rootData?.visitorCountry ?? null);
  const vatIncluded = !quote || (!quote.blocked && quote.duty === 'none');
  const shipBlocked = quote?.blocked === true;
  // What the order waits for today: every ship date in the cart.
  const cartDates = new Set(summary.lines.map((l) => l.shipPromise ?? ''));

  const add = async (items: BuildSuggestion[], key: string) => {
    if (!beginCartAdd()) return;
    setBusy(key);
    setFailed(null);
    try {
      const fields: Array<[string, string]> =
        items.length === 1
          ? [['sku', items[0].sku], ['qty', String(items[0].quantity)]]
          : [['lines', items.map((s) => `${s.sku}:${s.quantity}`).join(',')]];
      const next = await postCartAdd(CART_ACTION, fields);
      setSummary(next);
      for (const item of items) {
        trackEvent('Recommendation Add', {
          props: {
            product: item.handle,
            source_product: detail.handle ?? 'unknown',
            role: item.role,
            strategy: ranking.includes(item.handle) ? 'shopify-complementary' : 'compatibility',
          },
        });
      }
      void revalidator.revalidate();
    } catch {
      setFailed(key);
    } finally {
      endCartAdd();
      setBusy(null);
    }
  };

  // "Add all" adds only what is not in the cart yet, names the parts and
  // their total, and says when one of them holds the whole order back.
  const missing = suggestions.filter((s) => !summary.lines.some((l) => l.sku === s.sku));
  const totalOf = (items: BuildSuggestion[]) =>
    items.reduce((sum, s) => sum + Number(s.variant.price.amount) * s.quantity, 0);
  const currency = suggestions[0]?.variant.price.currencyCode ?? 'EUR';
  const delaysOrder = (s: BuildSuggestion) =>
    Boolean(s.variant.shipPromise) && !cartDates.has(s.variant.shipPromise ?? '');
  const later = missing.filter(delaysOrder);
  const withOrder = missing.filter((s) => !delaysOrder(s));
  const partName = (s: BuildSuggestion) => {
    const role = t(`build_role_${s.role}`, s.product.title);
    return s.quantity > 1 ? `${s.quantity} ${t(`build_role_${s.role}_plural`, role)}` : role;
  };
  // Parts that ship on a date already in the cart go first, as one button;
  // parts that would hold the parcel back sit in their own group below.
  const soonParts = suggestions.filter((s) => !delaysOrder(s));
  const laterParts = suggestions.filter(delaysOrder);
  const soonAdded = soonParts.length > 0 && soonParts.every((s) => summary.lines.some((l) => l.sku === s.sku));
  const soonName = (s: BuildSuggestion) =>
    s.variant.title !== 'Default Title'
      ? `${s.quantity > 1 ? `${s.quantity}× ` : ''}${s.product.title} ${variantDisplayName(s.product.handle, s.variant.title)}`
      : `${s.quantity > 1 ? `${s.quantity}× ` : ''}${s.product.title}`;
  const soonPromise = soonParts.find((s) => s.variant.shipPromise)?.variant.shipPromise ?? null;
  const shipping = quote && !quote.blocked ? quote : null;
  // One matching part with nothing to explain rides on the button alone;
  // several, or one with a caveat (a spec not final, a size swap), are
  // also listed one by one.
  const soonNeedsList =
    soonParts.length > 1 ||
    soonParts.some((s) => s.replaces || isInternalSku(s.product.handle, s.variant.title));

  const renderSuggestion = (s: BuildSuggestion) => {
    const image = s.variant.image ?? s.product.featuredImage;
    const inCart = summary.lines.some((l) => l.sku === s.sku);
    const promise = s.variant.shipPromise;
    const delays = delaysOrder(s);
    return (
      <li className="cart-added-suggestion" key={s.sku}>
        {image ? (
          <img src={shopifyImageUrl(image.url, 128)} alt="" width={64} height={64} loading="lazy" />
        ) : (
          <span className="cart-line-noimage" aria-hidden="true">{s.product.title.slice(4, 5)}</span>
        )}
        <div>
          <strong>
            {s.quantity > 1 ? `${s.quantity}× ` : ''}
            {s.product.title}
          </strong>
          {s.variant.title !== 'Default Title' ? (
            <span>{variantDisplayName(s.product.handle, s.variant.title)}</span>
          ) : null}
          {isInternalSku(s.product.handle, s.variant.title) ? (
            <small className="cart-added-ship">
              {t(
                'build_spec_not_final',
                'Stator size and KV are not final. You are told them before the supplier order and can cancel then for a full refund.',
              )}
            </small>
          ) : null}
          <span className="cart-added-price">
            {formatPrice(Number(s.variant.price.amount) * s.quantity, s.variant.price.currencyCode)}
            {s.quantity > 1 ? (
              <em>
                {' '}
                {t('build_each', '{price} each', {
                  price: formatPrice(s.variant.price.amount, s.variant.price.currencyCode),
                })}
              </em>
            ) : null}
          </span>
          {s.replaces ? (
            <small className="cart-added-replaces">
              {t('build_replaces', 'Your cart has the {other} version, which does not fit this build.', {
                other: s.replaces,
              })}
            </small>
          ) : null}
          {promise ? (
            <small className={`cart-added-ship${delays ? ' is-later' : ''}`}>
              {delays
                ? t('build_delays', '{promise}. Your order then ships when this is ready.', {
                    promise: promise.charAt(0).toUpperCase() + promise.slice(1),
                  })
                : promise}
            </small>
          ) : null}
        </div>
        <button
          type="button"
          className="cart-added-add"
          disabled={inCart || busy !== null}
          onClick={() => void add([s], s.sku)}
        >
          {inCart
            ? t('build_added', 'Added')
            : busy === s.sku
              ? 'Adding…'
              : failed === s.sku
                ? t('build_retry', 'Try again')
                : t('build_add', 'Add')}
        </button>
      </li>
    );

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
        <button
          ref={closeRef}
          type="button"
          className="cart-added-close"
          aria-label={t('added_close', 'Close')}
          onClick={close}
        >
          ×
        </button>
        <header className="cart-added-head">
          <span className="cart-added-check" aria-hidden="true">✓</span>
          <div>
            <p className="cart-added-eyebrow">{t('added_eyebrow', 'Added to cart')}</p>
            <h2 id="cart-added-title">
              {t('added_title', '{count} in your cart', {count: String(summary.totalQuantity)})}
            </h2>
          </div>
        </header>

        {added.map((line) => (
          <div className="cart-added-line" key={line.sku}>
            {line.image ? (
              <img src={shopifyImageUrl(line.image.url, 144)} alt="" width={72} height={72} />
            ) : (
              <span className="cart-line-noimage" aria-hidden="true">{line.title.slice(4, 5) || line.title[0]}</span>
            )}
            <div>
              <strong>{line.title}</strong>
              {line.variantTitle && line.variantTitle !== 'Default Title' ? (
                <span>{variantDisplayName(line.handle, line.variantTitle)}</span>
              ) : null}
              {line.shipPromise ? (
                <small className="cart-added-ship">
                  {t('preorder_line_prefix', 'Pre-order')} · {line.shipPromise}
                </small>
              ) : null}
            </div>
            <div style={{display: 'grid', justifyItems: 'end', gap: '0.15rem'}}>
              {line.quantity > 1 ? <span className="cart-added-qty">× {line.quantity}</span> : null}
              {line.total ? (
                <span className="cart-added-price">{formatPrice(line.total.amount, line.total.currencyCode)}</span>
              ) : null}
            </div>
          </div>
        ))}

        {suggestions.length ? (
          <div className="cart-added-build">
            <p className="cart-added-build-title">
              {t('build_whole_title', 'Building a whole {build} drone? These parts match.', {
                build: build?.label ?? '',
              })}
            </p>
            <p className="cart-added-note">
              {t('build_whole_skip', 'Skip this if you are replacing parts.')}
            </p>
            {soonParts.length ? (
              <button
                type="button"
                className="cart-added-primary"
                disabled={busy !== null || soonAdded}
                onClick={() => void add(withOrder, 'with-order')}
              >
                <span>
                  {soonAdded
                    ? t('build_added', 'Added')
                    : busy === 'with-order'
                      ? 'Adding…'
                      : failed === 'with-order'
                        ? t('build_retry', 'Try again')
                        : t('build_add_matching', '+ Add the matching {parts} · {price}', {
                            parts: soonParts.map(soonName).join(', '),
                            price: formatPrice(totalOf(soonParts), currency),
                          })}
                </span>
                <small>
                  {/* A short date reads well here; a funding-target promise
                      is a paragraph and already sits on each part. */}
                  {soonPromise && soonPromise.length <= 40
                    ? t('build_ships_with_promise', 'Ships with your order: {promise}', {promise: soonPromise})
                    : t('build_ships_with', 'Same ship terms as the rest of your cart')}
                </small>
              </button>
            ) : null}
            {soonNeedsList ? (
              <ul className="cart-added-suggestions">{soonParts.map(renderSuggestion)}</ul>
            ) : null}
            {laterParts.length ? (
              <div className="cart-added-later">
                <p className="cart-added-later-title">
                  {t('build_later_title', 'Ship later (funding target)')}
                </p>
                <p className="cart-added-note">
                  {t('build_later_note', 'Adding these delays your whole parcel until the last one is ready.')}
                </p>
                <ul className="cart-added-suggestions">{laterParts.map(renderSuggestion)}</ul>
                {later.length > 1 ? (
                  <button
                    type="button"
                    className="cart-added-textlink"
                    disabled={busy !== null}
                    onClick={() => void add(later, 'later')}
                  >
                    {busy === 'later'
                      ? 'Adding…'
                      : t('build_add_rest', 'Add the rest of the {build} build ({price})', {
                          build: build?.label ?? '',
                          price: formatPrice(totalOf(later), currency),
                        })}
                  </button>
                ) : null}
              </div>
            ) : null}
            <Txt id="cart.build_not_included" as="p" className="cart-added-note" />
          </div>
        ) : null}

        {extras.length ? (
          <div className="cart-added-build">
            <p className="cart-added-build-title">{t('extras_title', 'Optional extras')}</p>
            <ul className="cart-added-suggestions">{extras.map(renderSuggestion)}</ul>
          </div>
        ) : null}

        <div className="cart-added-actions">
          {subtotal ? (
            <p className="cart-added-subtotal" style={{gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', margin: 0}}>
              <span>
                {summary.totalQuantity === 1
                  ? t('added_subtotal_single', 'Subtotal, 1 item')
                  : t('added_subtotal_many', 'Subtotal, {count} items', {count: String(summary.totalQuantity)})}
                <small style={{display: 'block', color: 'var(--color-text-muted)'}}>
                  {vatIncluded ? t('added_vat_incl', 'incl. VAT') : t('added_vat_export', 'no EU VAT charged')}
                  {shipping ? null : `, ${t('added_shipping_later', 'shipping at checkout')}`}
                </small>
              </span>
              <strong className="cart-added-price">{formatPrice(subtotal.amount, subtotal.currencyCode)}</strong>
            </p>
          ) : null}
          {subtotal && shipping ? (
            // The same flat rate and country as the product page and the
            // cart, so the all-in number shows up before the cart page.
            <p className="cart-added-shipline">
              {t('added_shipping_total', 'Shipping to {country} {rate} · Estimated total {total}', {
                country: countryName(shipping.country),
                rate: formatPrice(shipping.rate, 'EUR'),
                total: formatPrice(Number(subtotal.amount) + shipping.rate, subtotal.currencyCode),
              })}
            </p>
          ) : null}
          {shipBlocked ? null : (
            // A plain form post: the cart action checks every line again and
            // redirects to Shopify checkout, or back to /cart with a notice.
            <form
              method="post"
              action={CART_ACTION}
              style={{gridColumn: '1 / -1', margin: 0}}
              onSubmit={() =>
                trackCheckoutClick(
                  subtotal ? {currency: subtotal.currencyCode, amount: Number(subtotal.amount)} : null,
                )
              }
            >
              <input type="hidden" name="intent" value="checkout" />
              <button
                type="submit"
                className="cart-added-view"
                style={{width: '100%', border: 0, font: 'inherit', fontWeight: 600, cursor: 'pointer'}}
              >
                {copyText('cart.checkout_cta') ?? 'Checkout'}
              </button>
            </form>
          )}
          <button type="button" className="cart-added-continue" onClick={close}>
            {t('added_continue', 'Continue shopping')}
          </button>
          <Link
            className="cart-added-continue"
            to="/cart"
            prefetch="intent"
            style={{display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', color: 'var(--color-text)'}}
          >
            {t('added_view', 'View cart')}
          </Link>
        </div>
      </section>
    </div>
  );
}
