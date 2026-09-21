import {useCallback, useEffect, useRef, useState} from 'react';
import {Link, useLocation, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {isPurchasableStatus} from '~/lib/product-content';
import type {CartSummary} from '~/lib/shopify-cart-action';
import {trackEvent} from '~/lib/growth/plausible';
import {
  CART_ADDED_EVENT,
  postCartAdd,
  type CartAddedDetail,
} from '~/lib/cart-client';
import {
  buildSuggestionSpecs,
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
  const closeRef = useRef<HTMLButtonElement>(null);
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
  const added = summary.lines.filter((l) => l.sku && detail.skus.includes(l.sku));
  // What the order waits for today: every ship date in the cart.
  const cartDates = new Set(summary.lines.map((l) => l.shipPromise ?? ''));

  const add = async (items: BuildSuggestion[], key: string) => {
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
      setBusy(null);
    }
  };

  const buildTotal = suggestions.reduce(
    (sum, s) => sum + Number(s.variant.price.amount) * s.quantity,
    0,
  );
  const currency = suggestions[0]?.variant.price.currencyCode ?? 'EUR';

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
              <img src={line.image.url} alt="" width={72} height={72} />
            ) : (
              <span className="cart-line-noimage" aria-hidden="true">{line.title.slice(4, 5) || line.title[0]}</span>
            )}
            <div>
              <strong>{line.title}</strong>
              {line.variantTitle && line.variantTitle !== 'Default Title' ? (
                <span>{line.variantTitle}</span>
              ) : null}
              {line.shipPromise ? (
                <small className="cart-added-ship">
                  {t('preorder_line_prefix', 'Pre-order')} · {line.shipPromise}
                </small>
              ) : null}
            </div>
            {line.quantity > 1 ? <span className="cart-added-qty">× {line.quantity}</span> : null}
          </div>
        ))}

        {suggestions.length ? (
          <div className="cart-added-build">
            <p className="cart-added-build-title">
              {t('build_title', 'Complete your {build} build', {build: build?.label ?? ''})}
            </p>
            <ul className="cart-added-suggestions">
              {suggestions.map((s) => {
                const image = s.variant.image ?? s.product.featuredImage;
                const inCart = summary.lines.some((l) => l.sku === s.sku);
                const promise = s.variant.shipPromise;
                const delays = !cartDates.has(promise ?? '');
                return (
                  <li className="cart-added-suggestion" key={s.sku}>
                    {image ? (
                      <img src={image.url} alt="" width={64} height={64} loading="lazy" />
                    ) : (
                      <span className="cart-line-noimage" aria-hidden="true">{s.product.title.slice(4, 5)}</span>
                    )}
                    <div>
                      <strong>
                        {s.quantity > 1 ? `${s.quantity}× ` : ''}
                        {s.product.title}
                      </strong>
                      {s.variant.title !== 'Default Title' ? <span>{s.variant.title}</span> : null}
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
              })}
            </ul>
            {suggestions.length > 1 && suggestions.some((s) => !summary.lines.some((l) => l.sku === s.sku)) ? (
              <button
                type="button"
                className="cart-added-all"
                disabled={busy !== null}
                onClick={() => void add(suggestions.filter((s) => !summary.lines.some((l) => l.sku === s.sku)), 'all')}
              >
                {busy === 'all'
                  ? 'Adding…'
                  : t('build_add_all', 'Add the whole build · {price}', {
                      price: formatPrice(buildTotal, currency),
                    })}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="cart-added-actions">
          <button type="button" className="cart-added-continue" onClick={close}>
            {t('added_continue', 'Continue shopping')}
          </button>
          <Link className="cart-added-view" to="/cart" prefetch="intent">
            {t('added_view', 'View cart')}
          </Link>
        </div>
      </section>
    </div>
  );
}
