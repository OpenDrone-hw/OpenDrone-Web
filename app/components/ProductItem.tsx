import {useCallback} from 'react';
import {Link} from 'react-router';
import {SmoothImage} from './SmoothImage';
import {ProductGhostTile} from './ProductGhostTile';
import {formatPrice} from '~/lib/catalog';
import type {
  MoneyV2,
  ProductCardFragment,
  ProductImage,
} from '~/lib/product-shapes';
import {useVariantUrl} from '~/lib/variants';
import {useProductStatus, useRoadmapStatus} from '~/lib/coming-soon';
import {isPurchasableStatus} from '~/lib/product-content';
import {AddToCartButton} from './AddToCartButton';
import {StackQuickAdd, type StackOffer} from './StackQuickAdd';
import {copyText} from '~/lib/copy';

/** Hover quick-add for catalog cards: the card's own hand-off link, so
 *  ordering never requires opening the PDP. */
export type ProductQuickAdd = {
  href: string;
  available: boolean;
};

/**
 * One model/tier of a product line, surfaced as a chip under the card on
 * the browse page. `axis` is the catalog option name (standardised to
 * "Model"); a real model deep-links to the PDP with that model
 * preselected (`?<axis>=<value>`), a coming-soon model renders greyed and
 * non-interactive (no purchasable variant yet).
 */
export type ProductModelChip = {
  value: string;
  axis: string;
  comingSoon?: boolean;
};

export function ProductItem({
  product,
  loading,
  imageSizes,
  models,
  feature,
  lead,
  isNew,
  onSale,
  to,
  title,
  priceOverride,
  imageOverride,
  comingSoon,
  quickAdd,
  stackOffers,
}: {
  product: ProductCardFragment;
  loading?: 'eager' | 'lazy';
  /** The card image's rendered width, for the srcset; defaults to a
   *  full-width card on phones. */
  imageSizes?: string;
  models?: ProductModelChip[];
  /** Wide horizontal layout for a single-product category row, so the
   *  flagship fills the rail instead of leaving it empty. */
  feature?: boolean;
  /** Editorial one-liner shown in the feature layout (the product's hero
   *  lead). Ignored outside `feature`. */
  lead?: string;
  /** Corner badge - recently added product. */
  isNew?: boolean;
  /** Corner badge - listed below its compare-at price. */
  onSale?: boolean;
  /** Link override - used by per-variant cards to deep-link the PDP with a
   *  model preselected (`?Model=…`) instead of the bare product URL. */
  to?: string;
  /** Display-title override - used by per-variant cards (e.g. "OpenRX Gemini"
   *  instead of just "OpenRX"). */
  title?: string;
  /** Price override - the specific variant's price for per-variant cards. */
  priceOverride?: MoneyV2;
  /** Image override - the specific variant's image for per-variant cards.
   *  Without it every tier card falls back to the product's featuredImage
   *  (the first uploaded render), so 20×20 and 30×30 show the same board. */
  imageOverride?: ProductImage | null;
  /** Unreleased product - renders greyed and non-clickable with a "Coming
   *  soon" badge instead of a link (nothing to buy or open yet). */
  comingSoon?: boolean;
  /** Hover quick-add: adds this card's variant without opening the PDP. */
  quickAdd?: ProductQuickAdd;
  /** Stack offers layered on the quick-add (FC/ESC cards): hovering the add
   *  button also offers the size-matched pair in one click. */
  stackOffers?: StackOffer[];
}) {
  const variantUrl = useVariantUrl(product.handle);

  // Cursor-tracked gold spotlight (same recipe as .related-card): write the
  // pointer position into CSS vars the card's ::after radial reads. Mouse
  // only - touch/pen never hover - and the ::after itself is gated behind
  // @media (hover: hover) in app.css, so this is a no-op on touch devices.
  const onSpotMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
  }, []);
  const url = to ?? variantUrl;
  const displayTitle = title ?? product.title;
  const price = priceOverride ?? product.priceRange.minVariantPrice;
  const image = imageOverride ?? product.featuredImage;
  const hasModels = Boolean(models && models.length > 0);

  // Product-level coming-soon (PUBLIC_COMING_SOON / per-SKU override):
  // unlike the `comingSoon` prop (unreleased tier, non-clickable tile) the
  // card stays clickable - the PDP hosts the notify-at-launch signup - but
  // shows no price and no quick-add.
  const status = useProductStatus(product.handle);
  const roadmapStatus = useRoadmapStatus(product.handle);
  const launchPending = !isPurchasableStatus(status);
  const showPrice = !launchPending;

  // Quick-add overlay: revealed on card hover (always visible on touch).
  // Rendered as a SIBLING of the card link, never inside it - a form inside
  // an anchor is invalid HTML and hijacks the navigation click.
  const quickAddNode =
    quickAdd && !comingSoon && !launchPending && !feature ? (
      <div className="product-card-quickadd">
        <StackQuickAdd offers={stackOffers ?? []}>
          <AddToCartButton
            className="product-card-quickadd-btn"
            href={quickAdd.href}
            product={product.handle}
            disabled={!quickAdd.available}
          >
            {copyText('product-chrome.card_add_to_cart')}
          </AddToCartButton>
        </StackQuickAdd>
      </div>
    ) : null;

  // Roadmap products carry their status word on the card, same vocabulary
  // and dot as the kanban and the PDP chip. A span, not a link: the whole
  // card is already an anchor, and nested anchors are invalid - the
  // "what the labels mean" link lives once per listing, in the grid header.
  // A pre-order product wears the pre-order badge instead of its roadmap
  // chip: the buyable state is the news on a card. Unreleased tiers
  // (`comingSoon` prop) keep their own badge.
  const badge =
    status === 'preorder' && !comingSoon ? (
      <span className="product-card-badge is-preorder">
        {copyText('product-chrome.card_badge_preorder')}
      </span>
    ) : roadmapStatus ? (
    <span
      className="product-card-status"
      data-status={roadmapStatus}
      title={copyText(`roadmap.status_${roadmapStatus}_legend`)}
    >
      <span className="kanban-dot" aria-hidden="true" />
      {copyText(`roadmap.status_${roadmapStatus}_label`)}
    </span>
  ) : comingSoon || launchPending ? (
    <span className="product-card-badge is-soon">
      {copyText(
        status === 'idea'
          ? 'product-chrome.card_badge_concept'
          : 'product-chrome.card_badge_coming_soon',
      )}
    </span>
  ) : onSale ? (
    <span className="product-card-badge is-sale">
      {copyText('product-chrome.card_badge_sale')}
    </span>
  ) : isNew ? (
    <span className="product-card-badge is-new">
      {copyText('product-chrome.card_badge_new')}
    </span>
  ) : null;

  const modelStrip = hasModels ? (
    <div className="product-card-models">
      {models!.map((m) =>
        m.comingSoon ? (
          <span
            key={m.value}
            className="product-card-model is-comingsoon"
            title={copyText('product-chrome.card_model_soon_title')}
          >
            {m.value}
          </span>
        ) : (
          <Link
            key={m.value}
            className="product-card-model"
            prefetch="viewport"
            to={`${variantUrl}?${encodeURIComponent(m.axis)}=${encodeURIComponent(
              m.value,
            )}`}
          >
            {m.value}
          </Link>
        ),
      )}
    </div>
  ) : null;

  // Feature layout - image left, editorial copy + model chips right. Used
  // for category sections with a single product so the flagship spans the
  // full rail. The media and the headline are separate links (no nested
  // anchors); the chips are their own links too.
  if (feature) {
    return (
      <article className="product-feature">
        <Link
          className="product-feature-media"
          prefetch="viewport"
          to={variantUrl}
          aria-hidden="true"
          tabIndex={-1}
        >
          {image ? (
            <SmoothImage
              alt={image.altText || product.title}
              data={image}
              loading={loading}
              sizes="(min-width: 64em) 340px, 100vw"
              maxWidth={960}
            />
          ) : (
            <ProductGhostTile
              type={('productType' in product && product.productType) || null}
              title={product.title}
            />
          )}
        </Link>
        <div className="product-feature-body">
          <Link
            className="product-feature-headline"
            prefetch="viewport"
            to={variantUrl}
          >
            <div className="product-card-row">
              <h2 className="product-card-title">{product.title}</h2>
              {showPrice ? (
                <span className="product-card-price">
                  {formatPrice(
                    product.priceRange.minVariantPrice.amount,
                    product.priceRange.minVariantPrice.currencyCode,
                  )}
                </span>
              ) : null}
            </div>
            {'productType' in product && product.productType ? (
              <p className="product-card-meta">{product.productType}</p>
            ) : null}
          </Link>
          {lead ? <p className="product-feature-lead">{lead}</p> : null}
          {modelStrip}
        </div>
      </article>
    );
  }

  const inner = (
    <>
      <div className={`product-card-media${image ? '' : ' is-empty'}`}>
        {badge}
        {image ? (
          <SmoothImage
            alt={image.altText || product.title}
            aspectRatio="1/1"
            data={image}
            loading={loading}
            sizes={imageSizes ?? '(min-width: 45em) 400px, 100vw'}
            maxWidth={800}
          />
        ) : (
          <ProductGhostTile
            type={('productType' in product && product.productType) || null}
            title={displayTitle}
          />
        )}
      </div>
      <div className="product-card-body">
        <div className="product-card-row">
          <h2 className="product-card-title">{displayTitle}</h2>
          {showPrice ? (
            <span className="product-card-price">
              {formatPrice(price.amount, price.currencyCode)}
            </span>
          ) : null}
        </div>
        {'productType' in product && product.productType ? (
          <p className="product-card-meta">{product.productType}</p>
        ) : null}
      </div>
    </>
  );

  // Unreleased - a non-interactive tile (nothing to open or buy yet).
  if (comingSoon) {
    return (
      <div className="product-card is-comingsoon" aria-disabled="true">
        {inner}
      </div>
    );
  }

  // Plain card - a single link wrapping the whole tile. With a quick-add the
  // wrapper becomes a div (the add button can't nest inside the anchor).
  if (!hasModels) {
    if (quickAddNode) {
      return (
        <div className="product-card has-quickadd" onPointerMove={onSpotMove}>
          <Link
            className="product-card-link"
            prefetch="viewport"
            viewTransition
            to={url}
          >
            {inner}
          </Link>
          {quickAddNode}
        </div>
      );
    }
    return (
      <Link
        className="product-card"
        prefetch="viewport"
        viewTransition
        to={url}
        onPointerMove={onSpotMove}
      >
        {inner}
      </Link>
    );
  }

  // Card with a model strip. The card chrome (border, hover lift) stays on
  // the outer element, but it can't be a <Link prefetch="viewport"> - the chips are their own
  // links and nesting anchors is invalid HTML. So the tile body is one link
  // and each model is a sibling link below it.
  return (
    <div
      className={`product-card has-models${quickAddNode ? ' has-quickadd' : ''}`}
      onPointerMove={onSpotMove}
    >
      <Link
        className="product-card-link"
        prefetch="viewport"
        viewTransition
        to={variantUrl}
      >
        {inner}
      </Link>
      {quickAddNode}
      {modelStrip}
    </div>
  );
}
