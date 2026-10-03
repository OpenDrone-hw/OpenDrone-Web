import {LoaderCircle} from 'lucide-react';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {variantDisplayName} from '~/lib/product-content';
import {shopifyImageUrl} from '~/lib/shopify-image';
import type {BuildSuggestion} from '~/lib/build-recommendations';
import {parcelDelay} from './ParcelChip';

function t(key: string, fallback: string, vars: Record<string, string> = {}): string {
  return (copyText(`cart.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** The cart form fields that add every part at once. */
export function bundleFields(parts: readonly BuildSuggestion[]): Array<[string, string]> {
  return [['lines', parts.map((p) => `${p.sku}:${p.quantity}`).join(',')]];
}

/**
 * The rest of the quad as one offer: the missing parts in a row, their
 * total and one button that adds them all. No date per part: the one line
 * under the button says when the parcel would ship, and only when adding
 * the parts moves it.
 */
export function BuildBundle({
  parts,
  label,
  cartPromises,
  busy,
  failed,
  onAdd,
}: {
  parts: readonly BuildSuggestion[];
  /** The build's name ("3-inch"), or null when the size is unknown. */
  label: string | null;
  /** The ship promises of the cart as it is. */
  cartPromises: Array<string | null | undefined>;
  busy: boolean;
  failed: boolean;
  onAdd: () => void;
}) {
  if (!parts.length) return null;
  const currency = parts[0].variant.price.currencyCode;
  const total = parts.reduce((sum, p) => sum + Number(p.variant.price.amount) * p.quantity, 0);
  // The latest part decides the parcel's date once they are all in.
  const delay = parts.reduce<ReturnType<typeof parcelDelay>>(
    (found, p) => parcelDelay([...cartPromises, ...parts.map((x) => x.variant.shipPromise)], p.variant.shipPromise) ?? found,
    null,
  );
  return (
    <div className="build-bundle">
      <p className="build-bundle-eyebrow">{t('bundle_eyebrow', 'Not in your cart')}</p>
      <p className="build-bundle-title">
        {label
          ? t('bundle_title_sized', 'Complete your {build} build', {build: label})
          : t('bundle_title', 'Complete your build')}
      </p>
      <ul className="build-bundle-parts">
        {parts.map((part) => {
          const image = part.variant.image ?? part.product.featuredImage;
          const name =
            part.variant.title !== 'Default Title'
              ? `${part.product.title} ${variantDisplayName(part.product.handle, part.variant.title)}`
              : part.product.title;
          return (
            <li key={part.sku}>
              {image ? (
                <img src={shopifyImageUrl(image.url, 96)} alt="" width={44} height={44} loading="lazy" />
              ) : (
                <span className="cart-line-noimage" aria-hidden="true" />
              )}
              <span className="build-bundle-name">{part.quantity > 1 ? `${part.quantity}x ${name}` : name}</span>
              <span className="build-bundle-price">
                {formatPrice(Number(part.variant.price.amount) * part.quantity, part.variant.price.currencyCode)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="build-bundle-foot">
        <span className="build-bundle-total">
          {t('bundle_total', '{count} parts · {price}', {
            count: String(parts.length),
            price: formatPrice(total, currency),
          })}
        </span>
        <button type="button" className="build-bundle-add" disabled={busy} aria-busy={busy || undefined} onClick={onAdd}>
          {busy ? (
            <span className="cart-action-label">
              <LoaderCircle className="cart-action-spinner" size={16} aria-hidden="true" />
              {t('add_busy', 'Adding…')}
            </span>
          ) : failed ? (
            t('build_retry', 'Try again')
          ) : (
            t('bundle_add', 'Add all {count}', {count: String(parts.length)})
          )}
        </button>
      </div>
      {delay ? (
        <small className="build-bundle-note" role="note">
          {t('bundle_delay', 'Your parcel would then ship {to}.', {to: delay.to})}
        </small>
      ) : null}
    </div>
  );
}
