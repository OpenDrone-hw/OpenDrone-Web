import {Suspense, useEffect, useRef, useState} from 'react';
import {Await, Link, useLocation} from 'react-router';
import type {ProductCardFragment as CollectionItemFragment} from '~/lib/product-shapes';
import {ProductItem} from '~/components/ProductItem';
import {PreorderStrip, type HomePrices} from '~/components/PreorderStrip';
import {
  DEFAULT_BUILD,
  TourCaption,
  stepProductUrl,
  useHeroBuilds,
} from '~/components/TourCaption';
import {copyText} from '~/lib/copy';
import {isConceptFor} from '~/lib/product-content';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
import {HOME_TOUR_STEPS, tourStillUrl} from '~/lib/home-tour-steps';

/**
 * Phone homepage (≤768px). The desktop homepage is the WebGL walkthrough
 * (DesktopHome in routes/_index.tsx), ~6 MB of GLBs, deliberately never loaded
 * on a phone. This is its phone counterpart: the same steps and words
 * (studio.json), a still of the scene per step, and the text block as a
 * sheet under it with the same build picks and Add buttons. Tap a dot, the
 * arrows, or swipe the picture to step; tap the picture of a part to open its
 * product page. Then the product tiles.
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
  return (
    <div className="home-mobile">
      {preorderShips !== null ? (
        <PreorderStrip ships={preorderShips || null} prices={prices} className="is-mobile" />
      ) : null}
      <h1 className="sr-only">OpenDrone</h1>
      <MobileTour />

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

function Chevron({dir}: {dir: 1 | -1}) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <polyline points={dir < 0 ? '15 5 8 12 15 19' : '9 5 16 12 9 19'} />
    </svg>
  );
}

/** The walkthrough on a phone: still, step controls, caption sheet. */
function MobileTour() {
  const steps = HOME_TOUR_STEPS;
  const total = steps.length;
  const [active, setActive] = useState(0);
  const go = (i: number) => setActive(Math.max(0, Math.min(total - 1, i)));
  const step = steps[active];
  const builds = useHeroBuilds();
  const [buildId, setBuildId] = useState(DEFAULT_BUILD);
  const productUrl = stepProductUrl(step, builds.find((b) => b.id === buildId));

  // /#build (the footer's build guide) and the part deep links open on
  // their step.
  const {hash} = useLocation();
  useEffect(() => {
    const id = hash.slice(1).toLowerCase();
    const i = steps.findIndex((st) => st.id === (id === 'motors' ? 'motor' : id));
    if (i >= 0) setActive(i);
  }, [hash, steps]);

  // Warm the neighbouring stills so a step never waits on its picture.
  useEffect(() => {
    for (const j of [active - 1, active + 1]) {
      const st = steps[j];
      if (st) new Image().src = tourStillUrl(st.id);
    }
  }, [active, steps]);

  // A horizontal swipe on the picture steps; vertical movement stays the
  // page's scroll (touch-action: pan-y on the stage).
  const start = useRef<{x: number; y: number} | null>(null);
  const swiped = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    start.current = {x: e.clientX, y: e.clientY};
    swiped.current = false;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s0 = start.current;
    start.current = null;
    if (!s0) return;
    const dx = e.clientX - s0.x;
    const dy = e.clientY - s0.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) swiped.current = true;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) go(active + (dx < 0 ? 1 : -1));
  };

  return (
    <section className="tour-m" aria-label={copyText('home.tour_label') ?? undefined}>
      <div
        className="tour-m-stage"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (start.current = null)}
      >
        <span className="home-mobile-glow" aria-hidden="true" />
        {(() => {
          const still = (
            <img
              key={step.id}
              className="tour-m-still"
              src={tourStillUrl(step.id)}
              alt=""
              width={900}
              height={738}
              decoding="async"
              fetchPriority={active === 0 ? 'high' : 'auto'}
              draggable={false}
            />
          );
          // The still of a part opens that part's product page.
          return productUrl ? (
            <Link
              to={productUrl}
              prefetch="intent"
              className="tour-m-still-link"
              aria-label={step.title}
              draggable={false}
              onClick={(e) => {
                // A swipe that ends on the picture steps, it does not open.
                if (swiped.current) e.preventDefault();
              }}
            >
              {still}
            </Link>
          ) : (
            still
          );
        })()}
      </div>

      <div className="tour-m-controls">
        <button
          type="button"
          className="tour-m-arrow"
          aria-label={copyText('home.tour_prev') ?? undefined}
          disabled={active === 0}
          onClick={() => go(active - 1)}
        >
          <Chevron dir={-1} />
        </button>
        <nav className="tour-m-rail" aria-label={copyText('home.tour_label') ?? undefined}>
          {steps.map((st, i) => (
            <button
              key={st.id}
              type="button"
              className={`tour-m-dot${i === active ? ' on' : ''}${i < active ? ' done' : ''}`}
              aria-label={`${i + 1}. ${st.title}`}
              aria-current={i === active ? 'step' : undefined}
              onClick={() => go(i)}
            />
          ))}
        </nav>
        <button
          type="button"
          className="tour-m-arrow"
          aria-label={copyText('home.tour_next') ?? undefined}
          disabled={active === total - 1}
          onClick={() => go(active + 1)}
        >
          <Chevron dir={1} />
        </button>
      </div>

      <div className="tour-m-sheet">
        <div className="tour-panel-body" key={step.id} aria-live="polite">
          <TourCaption
            step={step}
            index={active}
            total={total}
            builds={builds}
            buildId={buildId}
            onBuild={setBuildId}
          />
        </div>
      </div>
    </section>
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
