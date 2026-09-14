import {
  Link,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteLoaderData,
} from 'react-router';
import {useEffect, useState} from 'react';
import {ShopPayButton, type MappedProductOptions} from '@shopify/hydrogen';
import type {
  Maybe,
  ProductOptionValueSwatch,
} from '@shopify/hydrogen/storefront-api-types';
import {AddToCartButton} from './AddToCartButton';
import {StackQuickAdd, type StackOffer} from './StackQuickAdd';
import {useAside} from './Aside';
import {useComingSoon, useProductStatus} from '~/lib/coming-soon';
import {copyText} from '~/lib/copy';
import type {RootLoader} from '~/root';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {trackCheckoutClick} from '~/lib/growth/checkout-beacon';
import type {ProductFragment} from 'storefrontapi.generated';

export function ProductForm({
  productOptions,
  selectedVariant,
  hideOptionNames,
  bundleLines,
  bundleDisabled,
  bundleCtaLabel,
  stackOffers,
}: {
  productOptions: MappedProductOptions[];
  selectedVariant: ProductFragment['selectedOrFirstAvailableVariant'];
  /** Option names already handled elsewhere (e.g. the comparison ladder
   *  owns the line's primary axis), so the pill grid skips them and
   *  renders only the Add-to-cart button for that axis. */
  hideOptionNames?: string[];
  /** Bundle products are a display shell: the page renders from the bundle
   *  product, but add-to-cart drops the *component* variants as separate
   *  lines instead of a phantom bundle SKU. When set, these lines replace
   *  the single-variant add. `undefined` → normal single-product behaviour. */
  bundleLines?: Array<{merchandiseId: string; quantity: number}>;
  bundleDisabled?: boolean;
  bundleCtaLabel?: string;
  /** "Buy it as a stack" offers revealed on hover of the CTA — one click
   *  adds this board plus the size-matched partner (FC↔ESC). */
  stackOffers?: StackOffer[];
}) {
  const navigate = useNavigate();
  const {open} = useAside();
  // Variant switches are server navigations; on a slow connection the pill
  // used to give no feedback until the new loader data landed (only the
  // global RouteProgress bar moved). Track which pill was clicked and mark
  // it aria-busy/is-pending until the navigation settles.
  const navigation = useNavigation();
  const location = useLocation();
  const [pendingOption, setPendingOption] = useState<string | null>(null);
  // Clear on idle (slow navigations) AND on search change (prefetched ones
  // settle inside one render batch without an observable 'loading' state).
  useEffect(() => {
    if (navigation.state === 'idle') setPendingOption(null);
  }, [navigation.state, location.search]);
  const isBundle = bundleLines !== undefined;
  // Pre-order products take the order now and ship later, so the CTA says
  // so; the bundle CTA is the caller's label and is unchanged.
  const productStatus = useProductStatus(selectedVariant?.product?.handle);
  const ctaLabelAvailable =
    productStatus === 'preorder'
      ? (copyText('product-chrome.buy_cta_preorder') ?? 'Pre-order')
      : 'Add to cart';
  const ctaLabelSoldOut = 'Sold out';
  const hidden = new Set((hideOptionNames ?? []).map((n) => n.trim().toLowerCase()));
  // Shop Pay accelerated checkout under the main CTA. Hard-gated on the
  // coming-soon lock (belt and braces: the PDP already swaps this whole form
  // for the notify signup while locked) and on purchasability, so the locked
  // shop never renders a checkout entry point. Variant selection drives it:
  // the ids re-derive from selectedVariant / bundleLines on every switch.
  // shop-js parses store-url with `new URL()`, so the bare
  // PUBLIC_STORE_DOMAIN ("x.myshopify.com") must become a full https URL or
  // the button renders dead with a console TypeError.
  const rawStoreDomain =
    useRouteLoaderData<RootLoader>('root')?.publicStoreDomain;
  const storeDomain = rawStoreDomain
    ? rawStoreDomain.startsWith('http')
      ? rawStoreDomain
      : `https://${rawStoreDomain}`
    : undefined;
  const soon = useComingSoon(selectedVariant?.product?.handle);
  const buyable = isBundle
    ? !(bundleDisabled ?? bundleLines!.length === 0)
    : Boolean(selectedVariant?.availableForSale);
  const shopPayVariants = isBundle
    ? bundleLines!.map((l) => ({id: l.merchandiseId, quantity: l.quantity}))
    : selectedVariant
      ? [{id: selectedVariant.id, quantity: 1}]
      : [];
  return (
    <div className="product-form">
      {productOptions.map((option) => {
        // If there is only a single value in the option values, don't display the option
        if (option.optionValues.length === 1) return null;
        // Skip axes owned by another selector (the comparison ladder).
        if (hidden.has(option.name.trim().toLowerCase())) return null;

        return (
          <div key={option.name} className="mb-4">
            <h3 className="font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
              {option.name}
            </h3>
            <div className="product-options-grid">
              {option.optionValues.map((value) => {
                const {
                  name,
                  handle,
                  variantUriQuery,
                  selected,
                  available,
                  exists,
                  isDifferentProduct,
                  swatch,
                } = value;

                if (isDifferentProduct) {
                  // SEO
                  // When the variant is a combined listing child product
                  // that leads to a different url, we need to render it
                  // as an anchor tag
                  return (
                    <Link
                      className="product-options-item"
                      key={option.name + name}
                      prefetch="viewport"
                      preventScrollReset
                      replace
                      to={`/products/${handle}?${variantUriQuery}`}
                      aria-label={name}
                      aria-current={selected ? 'page' : undefined}
                      style={{
                        opacity: available ? 1 : 0.3,
                      }}
                    >
                      <ProductOptionSwatch swatch={swatch} name={name} />
                    </Link>
                  );
                } else {
                  // SEO
                  // When the variant is an update to the search param,
                  // render it as a button with javascript navigating to
                  // the variant so that SEO bots do not index these as
                  // duplicated links
                  const pending = pendingOption === option.name + name;
                  return (
                    <button
                      type="button"
                      className={`product-options-item${
                        exists && !selected ? ' link' : ''
                      }${pending ? ' is-pending' : ''}`}
                      key={option.name + name}
                      style={{
                        opacity: available ? 1 : 0.3,
                      }}
                      disabled={!exists}
                      aria-label={name}
                      aria-pressed={selected}
                      aria-busy={pending || undefined}
                      onClick={() => {
                        if (!selected) {
                          setPendingOption(option.name + name);
                          // Same event as the PDP's tier ladder: any
                          // user-initiated variant switch is one
                          // `Variant Select`.
                          trackEvent('Variant Select', {
                            props: {
                              product:
                                selectedVariant?.product?.handle ?? 'unknown',
                              variant: name,
                              source: attributionSource(),
                            },
                          });
                          void navigate(`?${variantUriQuery}`, {
                            replace: true,
                            preventScrollReset: true,
                          });
                        }
                      }}
                    >
                      <ProductOptionSwatch swatch={swatch} name={name} />
                    </button>
                  );
                }
              })}
            </div>
            <br />
          </div>
        );
      })}
      <StackQuickAdd
        offers={stackOffers ?? []}
        flyImage={selectedVariant?.image?.url}
        onAdd={() => open('cart')}
      >
        <AddToCartButton
          disabled={
            isBundle
              ? (bundleDisabled ?? bundleLines!.length === 0)
              : !selectedVariant || !selectedVariant.availableForSale
          }
          onClick={() => {
            open('cart');
          }}
          flyImage={selectedVariant?.image?.url}
          lines={
            isBundle
              ? bundleLines!
              : selectedVariant
                ? [
                    {
                      merchandiseId: selectedVariant.id,
                      quantity: 1,
                      selectedVariant,
                    },
                  ]
                : []
          }
        >
          {isBundle
            ? (bundleCtaLabel ?? 'Add to cart')
            : selectedVariant?.availableForSale
              ? ctaLabelAvailable
              : ctaLabelSoldOut}
        </AddToCartButton>
      </StackQuickAdd>
      {!soon && buyable && storeDomain && shopPayVariants.length > 0 ? (
        // Express checkout skips the cart CTA, so it must count as a
        // Checkout Click (event + chk:<day> beacon) or ShopPay sales
        // vanish from the buy-rate denominator while their orders still
        // land in the numerator. The web component is nested shadow DOM
        // (no iframe), so composed clicks reach this capture handler;
        // verified in-browser during the #303 review.
        <div
          onClickCapture={() => {
            const amount = Number.parseFloat(
              selectedVariant?.price?.amount ?? '',
            );
            trackCheckoutClick(
              Number.isFinite(amount) && selectedVariant?.price?.currencyCode
                ? {currency: selectedVariant.price.currencyCode, amount}
                : null,
            );
          }}
        >
          <ShopPayButton
            className="product-buy-shoppay"
            variantIdsAndQuantities={shopPayVariants}
            storeDomain={storeDomain}
            channel="hydrogen"
          />
        </div>
      ) : null}
    </div>
  );
}

function ProductOptionSwatch({
  swatch,
  name,
}: {
  swatch?: Maybe<ProductOptionValueSwatch> | undefined;
  name: string;
}) {
  const image = swatch?.image?.previewImage?.url;
  const color = swatch?.color;

  if (!image && !color) return name;

  return (
    <div
      aria-hidden="true"
      className="product-option-label-swatch"
      style={{
        backgroundColor: color || 'transparent',
      }}
    >
      {!!image && (
        <img src={image} alt="" width={20} height={20} loading="lazy" decoding="async" />
      )}
    </div>
  );
}
