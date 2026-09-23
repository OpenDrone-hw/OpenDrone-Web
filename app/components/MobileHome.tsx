import {Suspense} from 'react';
import {Await, Link} from 'react-router';
import {motion, useReducedMotion, type MotionProps} from 'motion/react';
import type {ProductCardFragment as CollectionItemFragment} from '~/lib/product-shapes';
import {HeroWordmark} from '~/components/HeroWordmark';
import {ProductItem} from '~/components/ProductItem';
import {Txt} from '~/components/Txt';
import {PreorderStrip, type HomePrices} from '~/components/PreorderStrip';
import {isConceptFor} from '~/lib/product-content';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
import {BOARD_ART_VERSION} from '~/data/board-art-version';
import {assetUrl} from '~/lib/asset-url';

// Downscaled WebP thumbnails written by scripts/export-board-art.mjs next to
// front.png. The stage slot is at most 264 CSS px, so 528 (2x) and 800 (3x)
// cover every phone at a tenth of the 1568 px PNG. Same ?v= cache-bust as
// BoardArt so a regenerated render is refetched.
const boardThumb = (handle: string, w: 528 | 800) =>
  assetUrl(
    `/boards/${handle}/front-w${w}.webp${BOARD_ART_VERSION ? `?v=${BOARD_ART_VERSION}` : ''}`,
  );
// Mirrors .home-mobile-board: width clamp(178px, 54vw, 264px).
const BOARD_THUMB_SIZES = '(min-width: 489px) 264px, 54vw';

/**
 * Phone homepage (≤768px). The desktop homepage IS the WebGL hero scene +
 * scroll-pinned choreography (DesktopHome in routes/_index.tsx) - ~6.3 MB of
 * GLBs and a scroll story tuned for a mouse, deliberately never loaded on a
 * phone. This is the mobile counterpart: not a plain fallback but a hero in its
 * own right - the animated wordmark, a floating "stack" of the real board
 * renders under a gold glow (the desktop hero's product showcase, distilled),
 * and the Shop button - then the product tiles. No 3D, no scroll tricks.
 */
export function MobileHome({
  featured,
  preorderShips = null,
  prices,
}: {
  featured: CollectionItemFragment[] | Promise<CollectionItemFragment[]>;
  /** Set while the shop is open: the promo line at the top. */
  preorderShips?: string | null;
  /** Price per product handle for the promo line. */
  prices: HomePrices;
}) {
  const reduce = useReducedMotion();

  // Staggered entrance: each block rises + fades a beat after the last. Skipped
  // wholesale under prefers-reduced-motion (rendered static, no transform).
  const rise = (i: number): MotionProps =>
    reduce
      ? {}
      : {
          initial: {opacity: 0, y: 18},
          animate: {opacity: 1, y: 0},
          transition: {
            duration: 0.55,
            delay: i * 0.09,
            ease: [0.22, 1, 0.36, 1],
          },
        };

  return (
    <div className="home-mobile">
      {preorderShips !== null ? (
        <PreorderStrip ships={preorderShips || null} prices={prices} className="is-mobile" />
      ) : null}
      <section className="home-mobile-hero">
        {/* Floating board "stack" - the two flagship boards (FC over ESC),
            offset like a mounted stack, on a gold-glow island. The desktop
            hero's rotatable 3D trio, distilled to a still that loads instantly. */}
        <motion.div className="home-mobile-stage" {...rise(0)} aria-hidden="true">
          <span className="home-mobile-glow" />
          {/* Float animation lives on the wrapper, drop-shadow on the img:
              animating transform on the filtered element itself forces weak
              GPUs to re-rasterize the shadow every frame of the infinite loop. */}
          <span className="home-mobile-board-float home-mobile-board-float--rear">
            <img
              className="home-mobile-board"
              src={boardThumb('openesc', 800)}
              srcSet={`${boardThumb('openesc', 528)} 528w, ${boardThumb('openesc', 800)} 800w`}
              sizes={BOARD_THUMB_SIZES}
              alt=""
              width={520}
              height={520}
              loading="eager"
              fetchPriority="low"
              decoding="async"
            />
          </span>
          <span className="home-mobile-board-float home-mobile-board-float--front">
            <img
              className="home-mobile-board"
              src={boardThumb('openfc-lite', 800)}
              srcSet={`${boardThumb('openfc-lite', 528)} 528w, ${boardThumb('openfc-lite', 800)} 800w`}
              sizes={BOARD_THUMB_SIZES}
              alt=""
              width={520}
              height={520}
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </span>
        </motion.div>

        <motion.h1
          className="home-mobile-wordmark"
          aria-label="OpenDrone"
          {...rise(1)}
        >
          <HeroWordmark progress={1} className="is-filled" />
        </motion.h1>

        {/* One primary action at full width. */}
        <motion.div className="home-mobile-cta" {...rise(2)}>
          <Link prefetch="viewport" to="/collections/all" className="btn-primary">
            <Txt id="home.shop" />
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </Link>
        </motion.div>
      </section>

      {/* The loader resolves `featured` for a mobile UA, so the cards render
          in the shell here with no Suspense boundary: React's streaming
          renderer outlines any boundary once the shell passes its progressive
          chunk size, so a resolved value inside <Await> still arrived as a
          late chunk and shifted the page (CLS 0.22). A promise (the
          desktop-first path resized down to a phone) still streams. */}
      {Array.isArray(featured) ? (
        <FeaturedGrid items={featured} />
      ) : (
        <Suspense fallback={null}>
          <Await resolve={featured} errorElement={null}>
            {(items) => <FeaturedGrid items={items} />}
          </Await>
        </Suspense>
      )}
    </div>
  );
}

function FeaturedGrid({items: all}: {items: CollectionItemFragment[]}) {
  // Concept products (planned / in-progress) never list.
  const roadmapStatus = useRoadmapStatusResolver();
  const items = all.filter(
    (p) => !isConceptFor(p.handle, roadmapStatus(p.handle)),
  );
  if (items.length === 0) return null;
  return (
    <section className="home-mobile-featured">
      <div className="home-mobile-grid">
        {items.map((product, i) => (
          <ProductItem
            key={product.id}
            product={product}
            loading={i === 0 ? 'eager' : 'lazy'}
          />
        ))}
      </div>
    </section>
  );
}
