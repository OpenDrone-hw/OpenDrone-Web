import {Suspense} from 'react';
import {Await, Link, useRouteLoaderData} from 'react-router';
import {Money, type OptimisticCartLineInput} from '@shopify/hydrogen';
import type {RootLoader} from '~/root';
import type {CartLine} from '~/components/CartLineItem';
import type {CartLayout} from '~/components/CartMain';
import type {
  HeaderFamilyProduct,
  HeaderFamilyVariant,
} from '~/components/Header';
import {AddToCartButton} from '~/components/AddToCartButton';
import {useAside} from '~/components/Aside';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {
  PRODUCT_CONTENT,
  isPurchasableStatus,
  type ProductStatus,
} from '~/lib/product-content';
import {useProductStatusResolver} from '~/lib/coming-soon';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';

/** The thin header-catalogue price ({amount, currencyCode} strings) cast to
 *  Money's expected shape — same pattern as the header pods. */
type MoneyData = React.ComponentProps<typeof Money>['data'];

/**
 * "Goes well with" — a compact, quiet row in the cart (drawer + page)
 * suggesting the size-matched stack partner for a board already in the cart
 * (OpenFC 20×20 in cart → OpenESC 20×20). Partner wiring comes from the
 * `stack` config in product-content.ts; product/variant data from the root
 * loader's deferred `familyProducts` (the same thin catalogue read the
 * header dropdowns use), so no extra query. One-click add via the standard
 * cart form.
 *
 * A partner is NOT suggested when it's already in the cart, when it's the
 * same product as the source line, when it's coming-soon-locked
 * (~/lib/coming-soon semantics: per-product override, else the global
 * flag), or when the matched variant isn't purchasable. First eligible
 * suggestion wins — this stays one quiet row, not a merchandising wall.
 */
export function CartCompanion({
  lines,
  layout,
}: {
  lines: CartLine[];
  layout: CartLayout;
}) {
  const rootData = useRouteLoaderData<RootLoader>('root');
  if (!rootData?.familyProducts) return null;
  return (
    <Suspense fallback={null}>
      <Await resolve={rootData.familyProducts} errorElement={null}>
        {(products) => (
          <CartCompanionRow
            lines={lines}
            layout={layout}
            products={products ?? []}
            // Mirrors useComingSoon's fail-closed default (~/lib/coming-soon):
            // no root flag → treat as coming soon → suggest nothing.
          />
        )}
      </Await>
    </Suspense>
  );
}

type Suggestion = {
  product: HeaderFamilyProduct;
  variant: HeaderFamilyVariant;
  size?: string;
};

function CartCompanionRow({
  lines,
  layout,
  products,
}: {
  lines: CartLine[];
  layout: CartLayout;
  products: HeaderFamilyProduct[];
}) {
  const {close} = useAside();
  const productStatus = useProductStatusResolver();

  const suggestion = findSuggestion(lines, products, productStatus);
  if (!suggestion) return null;

  const {product, variant, size} = suggestion;
  const title = size ? `${product.title} · ${size}` : product.title;
  const imageUrl = variant.image?.url ?? product.featuredImage?.url ?? null;

  // NOTE: <section>, not <aside> — the drawer's `.overlay aside` panel CSS
  // (fixed, 100vh, 400px) would hijack any nested <aside> element.
  return (
    <section
      className="cart-companion"
      aria-label={
        copyText('cart.companion_aria') ?? 'Suggested companion product'
      }
    >
      <Txt id="cart.companion_eyebrow" className="cart-companion-eyebrow" />
      <div className="cart-companion-row">
        <Link
          to={`/products/${product.handle}`}
          prefetch="intent"
          className="cart-companion-name"
          onClick={layout === 'aside' ? close : undefined}
        >
          {title}
        </Link>
        {variant.price ? (
          <span className="cart-companion-price">
            <Money data={variant.price as MoneyData} />
          </span>
        ) : null}
        <AddToCartButton
          className="cart-companion-add"
          ariaLabel={`Add ${title} to cart`}
          flyImage={imageUrl}
          onClick={() =>
            // Stack completion from the cart. The board(s) already in the
            // cart are not identified here (multi-line carts have no single
            // "product"); the partner + surface props carry the signal.
            trackEvent('Stack Toggle', {
              props: {
                partner: product.handle,
                surface: 'cart',
                source: attributionSource(),
              },
            })
          }
          lines={[
            {
              merchandiseId: variant.id,
              quantity: 1,
              // Minimal ProductVariant-ish shape so useOptimisticCart renders
              // the pending line immediately (same trick as the header pods).
              selectedVariant: {
                id: variant.id,
                title: variant.title,
                availableForSale: variant.availableForSale ?? true,
                price: variant.price,
                image: variant.image ?? null,
                product: {title: product.title, handle: product.handle},
                selectedOptions: variant.selectedOptions ?? [],
              } as unknown as NonNullable<
                OptimisticCartLineInput['selectedVariant']
              >,
            },
          ]}
        >
          <Txt id="cart.companion_add" />
        </AddToCartButton>
      </div>
    </section>
  );
}

function findSuggestion(
  lines: CartLine[],
  products: HeaderFamilyProduct[],
  productStatus: (handle?: string | null) => ProductStatus,
): Suggestion | null {
  // Root lines only — bundle children re-expand from their parent.
  const rootLines = lines.filter(
    (line) =>
      !('parentRelationship' in line && line.parentRelationship?.parent),
  );
  const inCart = new Set(
    rootLines
      .map((line) => line.merchandise?.product?.handle)
      .filter(Boolean),
  );

  for (const line of rootLines) {
    const handle = line.merchandise?.product?.handle;
    if (!handle) continue;
    const stack = PRODUCT_CONTENT[handle]?.stack;
    if (!stack) continue;

    const matchOption = (stack.matchOption ?? 'Model').trim().toLowerCase();
    const size = line.merchandise?.selectedOptions
      ?.find((o) => o.name.trim().toLowerCase() === matchOption)
      ?.value?.trim();

    for (const partner of stack.partners) {
      // Same product — nothing to pair.
      if (partner.handle === handle) continue;
      // Already in the cart — don't sell them a second one.
      if (inCart.has(partner.handle)) continue;
      // Coming-soon-locked — can't be bought, don't tease it here.
      if (!isPurchasableStatus(productStatus(partner.handle))) continue;

      const product = products.find((p) => p.handle === partner.handle);
      if (!product) continue;

      const variants = product.variants?.nodes ?? [];
      // Size-matched variant (20×20 FC → 20×20 ESC); a size-less source
      // line falls back to the partner's first purchasable variant.
      const variant = size
        ? variants.find((v) =>
            v.selectedOptions?.some(
              (o) =>
                o.name.trim().toLowerCase() === matchOption &&
                o.value.trim().toLowerCase() === size.toLowerCase(),
            ),
          )
        : variants.find((v) => v.availableForSale);
      if (!variant?.availableForSale || !variant.price) continue;

      return {product, variant, size};
    }
  }
  return null;
}
