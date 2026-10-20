import {useState} from 'react';
import {Link, useRevalidator, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {formatPrice} from '~/lib/catalog';
import {copyText} from '~/lib/copy';
import {isPurchasableStatus, variantDisplayName} from '~/lib/product-content';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {
  buildSuggestionSpecs,
  extraSuggestionSpecs,
  parseBuilds,
  resolveBuild,
  resolveBuildSuggestions,
  type BuildSuggestion,
} from '~/lib/build-recommendations';
import {CartAddError, postCart} from '~/lib/cart-client';
import {trackEvent} from '~/lib/growth/plausible';
import {BuildBundle, bundleFields} from '../BuildBundle';
import buildsJson from '../../../content/builds.json';
import '../../styles/cart-parity.css';

const BUILDS = parseBuilds(buildsJson);
const ADD = '/api/shopify/cart';
const isAccessory = (part: {role: string}) => part.role === 'props' || part.role === 'extra';

function t(key: string, fallback: string): string {
  return copyText(`cart.${key}`) ?? fallback;
}

/**
 * The cross-sell and upsell of the production cart, fed from the app's catalog (the root loader's cards): the rest of
 * the build as one bundle with an Add all button, and up to three cheap add-ons (props, spares) that go with what the
 * cart holds. The same specs, the same resolver and the same BuildBundle as the production cart page and drawer.
 * Hidden when nothing applies.
 */
export function SummarySuggestions({skus}: {skus: string[]}) {
  const root = useRouteLoaderData<RootLoader>('root');
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const products = root?.familyProducts ?? [];
  const statuses = root?.productStatuses ?? {};
  const sellable = (handle: string) => isPurchasableStatus(statuses[handle]);
  const lines = skus.map((sku) => ({sku, handle: ''}));
  const buildId = resolveBuild(BUILDS, null, skus);
  const buildLabel = BUILDS.builds.find((b) => b.id === buildId)?.label ?? null;
  const parts = resolveBuildSuggestions(products, buildSuggestionSpecs(BUILDS, buildId, lines), sellable);
  const build = parts.filter((p) => !isAccessory(p));
  const extras = [
    ...parts.filter(isAccessory),
    ...resolveBuildSuggestions(products, extraSuggestionSpecs(BUILDS, lines, parts.map((s) => s.sku)), sellable),
  ].slice(0, 3);
  if (!build.length && !extras.length) return null;

  const run = async (key: string, fields: Array<[string, string]>, props: Record<string, string>) => {
    if (busy) return;
    setBusy(key);
    setFailed(null);
    try {
      await postCart(ADD, fields);
      trackEvent('Recommendation Add', {props: {...props, source_product: 'cart'}});
      await revalidator.revalidate();
    } catch (error) {
      if (!(error instanceof CartAddError)) console.error('[cart] add failed');
      setFailed(key);
    } finally {
      setBusy(null);
    }
  };
  const disabled = busy !== null || revalidator.state !== 'idle';

  const row = (part: BuildSuggestion) => {
    const image = part.variant.image ?? part.product.featuredImage;
    return (
      <li className="cart-added-suggestion" key={part.sku}>
        {image ? <img src={shopifyImageUrl(image.url, 96)} alt="" width={48} height={48} loading="lazy" /> : <span className="cart-line-noimage" aria-hidden="true" />}
        <div>
          <Link className="cart-added-suggestion-name" to={`/products/${part.product.handle}`} prefetch="intent">
            {part.quantity > 1 ? `${part.quantity}x ` : ''}
            {part.variant.title !== 'Default Title' ? `${part.product.title} ${variantDisplayName(part.product.handle, part.variant.title)}` : part.product.title}
          </Link>
        </div>
        <span className="cart-added-price">{formatPrice(Number(part.variant.price.amount) * part.quantity, part.variant.price.currencyCode)}</span>
        <button
          type="button"
          className="cart-added-add"
          disabled={disabled}
          onClick={() => void run(part.sku, [['sku', part.sku], ['qty', String(part.quantity)]], {product: part.handle, role: part.role, strategy: part.role === 'extra' ? 'accessory' : 'compatibility'})}
        >
          {failed === part.sku ? t('build_retry', 'Try again') : t('build_add', 'Add')}
        </button>
      </li>
    );
  };

  return (
    <div className="co-extras">
      {extras.length ? (
        <div className="cart-addons">
          <p className="cart-added-build-title">{t('extras_title', 'Add-ons')}</p>
          <ul className="cart-added-suggestions">{extras.map(row)}</ul>
        </div>
      ) : null}
      {build.length ? (
        <div className="cart-suggest">
          <BuildBundle
            parts={build}
            label={buildLabel}
            cartPromises={[]}
            busy={busy === 'bundle' || revalidator.state !== 'idle'}
            failed={failed === 'bundle'}
            onAdd={() => void run('bundle', bundleFields(build), {product: build.map((p) => p.handle).join(','), role: 'bundle', strategy: 'compatibility'})}
          />
        </div>
      ) : null}
    </div>
  );
}
