import {Suspense, useCallback} from 'react';
import {Await, Link} from 'react-router';
import type {ProductCardFragment} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';
import {SmoothImage} from '~/components/SmoothImage';
import {AddToCartButton} from '~/components/AddToCartButton';
import {useComingSoon, useRoadmapStatusResolver} from '~/lib/coming-soon';
import {isConceptFor} from '~/lib/product-content';
import {PRODUCT_CONTENT} from '~/lib/product-content';

/** The related strip renders catalog cards, same as every listing. */
export type RelatedProduct = ProductCardFragment;

/** First clause of a spec cell - "AT32F421G8U7, 120 MHz" → "AT32F421G8U7". */
const clause = (s: string) => s.split(/[,(]/)[0].trim();

/**
 * One-line spec for a related card, composed from the product's editorial
 * spec table (product-content.ts): firmware project + MCU/radio when the
 * board has them, else the first spec rows, else the product family.
 * Derived, never invented - every cell already ships on the PDP.
 */
function specLineOf(p: RelatedProduct): string | null {
  const c = PRODUCT_CONTENT[p.handle];
  // No editorial file → the eyebrow already shows the productType; a second
  // identical line under the title would just stutter.
  if (!c) return null;
  const rows = c.specs ?? [];
  const cell = (key: string) =>
    rows.find(([k]) => k.toLowerCase() === key)?.[1];
  const parts: string[] = [];
  const fw = c.firmware?.project;
  if (fw && fw !== '-') parts.push(fw);
  const chip = cell('mcu') ?? cell('radio');
  if (chip) parts.push(clause(chip));
  // The base table describes one variant; with several (3" and 5" frames)
  // its first rows would contradict the "from" price, so name the variants.
  const variantNames = Object.keys(c.variants ?? {});
  if (parts.length === 0 && variantNames.length > 1) return variantNames.join(' · ');
  if (parts.length === 0) {
    for (const [, v] of rows.slice(0, 2)) parts.push(clause(v));
  }
  return parts.slice(0, 2).join(' · ') || null;
}

/** Mono eyebrow in catalog-number language: "FILE 02 · FLIGHT CONTROLLER". */
function fileLineOf(p: RelatedProduct): string | null {
  const c = PRODUCT_CONTENT[p.handle];
  if (c && c.fileNumber !== '-') return `File ${c.fileNumber} · ${c.family}`;
  return p.productType ?? null;
}

export function RelatedProducts({
  recommendations,
}: {
  recommendations: Promise<RelatedProduct[] | null>;
}) {
  const roadmapStatus = useRoadmapStatusResolver();
  return (
    <section className="related-products" aria-label="Related products">
      <h2 className="section-heading">Related hardware</h2>
      <Suspense fallback={<RelatedSkeleton />}>
        <Await resolve={recommendations} errorElement={null}>
          {(items) => {
            // Concept products (planned / in-progress) never list.
            const listed = (items ?? []).filter(
              (p) => !isConceptFor(p.handle, roadmapStatus(p.handle)),
            );
            if (listed.length === 0) return null;
            return (
              <div className="related-grid">
                {listed.slice(0, 4).map((product) => (
                  <RelatedCard key={product.id} product={product} />
                ))}
              </div>
            );
          }}
        </Await>
      </Suspense>
    </section>
  );
}

function RelatedCard({product}: {product: RelatedProduct}) {
  const comingSoon = useComingSoon(product.handle);
  const image = product.featuredImage;
  const min = product.priceRange.minVariantPrice;
  const max = product.priceRange.maxVariantPrice;
  const priced = parseFloat(min.amount) > 0;
  const fromPrice = priced && parseFloat(max.amount) > parseFloat(min.amount);
  const specLine = specLineOf(product);
  const fileLine = fileLineOf(product);

  // Quick-add only when the product has exactly ONE variant - a multi-model
  // line (FC/ESC/RX) must send the buyer to the PDP to pick a mount/model -
  // and never while the product is still gated coming-soon.
  const only =
    !comingSoon && product.variants.nodes.length === 1
      ? product.variants.nodes[0]
      : null;

  // Spotlight hover - a gold radial that follows the pointer (CSS vars read
  // by .related-card::after). Mouse-only, mirroring .product-card: touch
  // taps fire pointermove too and would pin a phantom glow (the ::after is
  // also gated behind (hover: hover) in app.css). Keyboard focus keeps the
  // plain border cue.
  const onMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
  }, []);

  return (
    <div
      className={`related-card${only ? ' has-quickadd' : ''}`}
      onPointerMove={onMove}
    >
      <Link
        className="related-card-link"
        prefetch="viewport"
        viewTransition
        to={`/products/${product.handle}`}
      >
        <div className={`related-card-media${image ? '' : ' is-empty'}`}>
          {image ? (
            <SmoothImage
              alt={image.altText || product.title}
              aspectRatio="1/1"
              data={image}
              loading="lazy"
              sizes="(min-width: 45em) 260px, 50vw"
              maxWidth={640}
            />
          ) : (
            <span className="product-card-media-ghost" aria-hidden="true">
              {product.productType || 'OpenDrone'}
            </span>
          )}
        </div>
        <div className="related-card-body">
          {fileLine ? <p className="related-card-file">{fileLine}</p> : null}
          <h3 className="related-card-title">{product.title}</h3>
          {specLine ? <p className="related-card-spec">{specLine}</p> : null}
          {/* Price is gated on coming-soon exactly like ProductItem's
              showPrice - useComingSoon() is fail-closed (defaults locked
              when root data is missing), so a locked shop never leaks a
              number here. */}
          <p className="related-card-price">
            {priced && !comingSoon ? (
              <>
                {fromPrice ? (
                  <span className="related-card-from">from</span>
                ) : null}
                <span>{formatPrice(min.amount, min.currencyCode)}</span>
              </>
            ) : (
              <span>&nbsp;</span>
            )}
          </p>
        </div>
      </Link>
      {only ? (
        <div className="related-card-quickadd">
          <AddToCartButton
            className="product-card-quickadd-btn"
            href={only.cartAddUrl}
            product={product.handle}
            disabled={!only.availableForSale}
          >
            Add to cart
          </AddToCartButton>
        </div>
      ) : null}
    </div>
  );
}

const SKELETON_IDS = ['s1', 's2', 's3', 's4'];

function RelatedSkeleton() {
  return (
    <div className="related-grid" aria-hidden="true">
      {SKELETON_IDS.map((id) => (
        <div key={id} className="related-card related-card-skeleton">
          <div className="related-card-media animate-pulse" />
          <div className="related-card-body">
            <div className="h-3 w-1/2 bg-[var(--color-bg-elevated)] rounded animate-pulse" />
            <div className="h-4 w-3/4 bg-[var(--color-bg-elevated)] rounded animate-pulse" />
            <div className="h-3 w-1/3 bg-[var(--color-bg-elevated)] rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
