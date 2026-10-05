import {Suspense, useState, type CSSProperties} from 'react';
import {Await, Link} from 'react-router';
import type {ProductCardFragment as CollectionItemFragment} from '~/lib/product-shapes';
import {HeroWordmark} from '~/components/HeroWordmark';
import {ProductItem} from '~/components/ProductItem';
import {EarlyBirdNote, anyEarlyPrice} from '~/components/EarlyPriceCue';
import {AnimatedNumber} from '~/components/AnimatedNumber';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {PRODUCT_CONTENT, isConceptFor} from '~/lib/product-content';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
import {BOARD_ART_VERSION} from '~/data/board-art-version';
import {assetUrl} from '~/lib/asset-url';
import {HeroBuildGuide} from '~/components/HeroBuildGuide';
import type {HeroBuild} from '~/lib/hero-build';
import {HERO_AIRFRAMES, DEFAULT_HERO_SIZE, airframeLabel} from '~/lib/hero-airframes';
import {CommunitySection} from '~/components/Discord';
import type {DiscordCounts} from '~/lib/discord-community';

// Downscaled WebP thumbnails written by scripts/export-board-art.mjs next to
// front.png. The stage slot is at most 264 CSS px, so 528 (2x) and 800 (3x)
// cover every phone at a tenth of the 1568 px PNG. Same ?v= cache-bust as
// BoardArt so a regenerated render is refetched.
const boardThumb = (handle: string, w: 528 | 800) =>
  assetUrl(
    `/boards/${handle}/front-w${w}.webp${BOARD_ART_VERSION ? `?v=${BOARD_ART_VERSION}` : ''}`,
  );
// Mirrors .home-mobile-board: width clamp(104px, 30vw, 150px).
const BOARD_THUMB_SIZES = '(min-width: 500px) 150px, 30vw';
const GITHUB_ORG = 'https://github.com/OpenDrone-hw';


/* Below-fold "index" band - the open-hardware ledger in the PDP's
 * spec-table language. Every row is a fact already published elsewhere on
 * the site (open-source page, PDP downloads); the design count is derived
 * from the product-content registry so it can't drift. */
const OPEN_DESIGN_COUNT = Object.values(PRODUCT_CONTENT).filter(
  // Resold parts (`editorial: false`) are catalog, not open designs.
  (c) => c.fileNumber !== '-' && c.editorial !== false,
).length;

/* Row order and which row is derived. Labels are copy
 * (`home.m_ledger_<key>_label`), and so is every value EXCEPT the design
 * count, which is computed from the registry so it can't drift - a value here
 * wins over the copy file. Only that derived count is a quantity worth
 * sweeping; licence versions, tool versions and prices are identifiers/fixed
 * figures and render static. */
const HOME_LEDGER: Array<{key: string; value?: string; countUp?: boolean}> = [
  {
    key: 'designs',
    value: String(OPEN_DESIGN_COUNT).padStart(2, '0'),
    countUp: true,
  },
  {key: 'licence'},
  {key: 'source_format'},
  {key: 'designed_in'},
];

/**
 * Phone homepage (≤768px). The desktop homepage IS the WebGL hero scene +
 * scroll-pinned choreography (DesktopHome in routes/_index.tsx) - ~6.3 MB of
 * GLBs and a scroll story tuned for a mouse, deliberately never loaded on a
 * phone. This is the mobile counterpart: not a plain fallback but a hero in its
 * own right - the animated wordmark, a floating "stack" of the real board
 * renders under a gold glow (the desktop hero's product showcase, distilled),
 * and a Dynamic-Island Shop pill - then a clear path to the flagship line and
 * the full catalogue. No 3D, no scroll tricks: fast, legible, touch-first.
 *
 * Kit-first: the board art stage is kept short so the build card (size
 * toggle, priced parts, ship date, total) starts on the first screen of a
 * 390 x 664 phone viewport. The hero renders visible in the server HTML; its
 * entrance is a CSS transform-only rise (`.home-mobile-rise`), never opacity.
 */
export function MobileHome({
  featured,
  heroBuilds,
  discord,
}: {
  featured: CollectionItemFragment[] | Promise<CollectionItemFragment[]>;
  heroBuilds: HeroBuild[] | Promise<HeroBuild[]>;
  discord: Promise<DiscordCounts | null>;
}) {
  const [buildSize, setBuildSize] = useState(DEFAULT_HERO_SIZE);
  // Staggered CSS entrance (transform only, so the hero is visible before JS).
  const rise = (i: number) => ({style: {'--rise-i': i} as CSSProperties});
  const buildCard = (builds: HeroBuild[]) => {
    const build = builds.find((item) => item.size === buildSize);
    return build ? (
      <HeroBuildGuide key={build.id} build={build} />
    ) : (
      <Link to="/products">
        <Txt id="home.build_browse" fallback="Browse parts" />
      </Link>
    );
  };

  return (
    <div className="home-mobile">
      <section className="home-mobile-hero">
        {/* Floating board "stack" - the two flagship boards (FC over ESC),
            offset like a mounted stack, on a gold-glow island. The desktop
            hero's rotatable 3D trio, distilled to a still that loads instantly. */}
        <div
          {...rise(0)}
          className="home-mobile-stage home-mobile-rise"
          aria-hidden="true"
        >
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
        </div>

        <h1
          {...rise(1)}
          className="home-mobile-wordmark home-mobile-rise"
          aria-label="OpenDrone"
        >
          <HeroWordmark progress={1} className="is-filled" />
        </h1>

        <Txt
          id="home.m_tagline"
          as="p"
          {...rise(2)}
          className="home-mobile-tagline home-mobile-rise"
        />

        <div {...rise(3)} className="home-mobile-cta home-mobile-rise">
          <Link
            prefetch="intent"
            to="/products"
            className="home-mobile-cta-btn home-mobile-cta-secondary"
          >
            <Txt id="home.m_shop_parts" />
          </Link>
        </div>
      </section>

      <section
        className="home-mobile-build"
        id="build-guide"
      >
        <div
          className="hero-build-sizes"
          role="group"
          aria-label={copyText('home.build_size_aria') ?? 'Build size'}
        >
          {HERO_AIRFRAMES.map(frame => <button key={frame.key} type="button" aria-pressed={frame.key === buildSize} onClick={() => setBuildSize(frame.key)}>{airframeLabel(frame.key)}</button>)}
        </div>
        {/* Resolved in the loader for a phone UA so the priced parts are in
            the server HTML; a promise (desktop-first resize) still streams. */}
        {Array.isArray(heroBuilds) ? (
          buildCard(heroBuilds)
        ) : (
          <Suspense fallback={<Txt id="home.build_loading" as="p" fallback="Loading build…" />}>
            <Await resolve={heroBuilds}>{buildCard}</Await>
          </Suspense>
        )}
      </section>

      {/* The loader resolves `featured` for a mobile UA, so the cards render
          in the shell here with no Suspense boundary: React's streaming
          renderer outlines any boundary once the shell passes its progressive
          chunk size, so a resolved value inside <Await> still arrived as a
          late chunk and shifted the ledger below (CLS 0.22). A promise (the
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

      {/* Open-hardware index - spec-table rows (hairline rules, mono keys,
          right-aligned values) with count-ups on the numerals. Reuses the
          PDP's .spec-table so the band IS the house datasheet language. */}
      <section
        className="home-mobile-ledger"
        aria-label={copyText('home.m_ledger_aria') ?? 'Open hardware index'}
      >
        <Txt id="home.m_ledger_label" as="p" className="section-label" />
        <dl className="spec-table">
          {HOME_LEDGER.map(({key, value, countUp}) => (
            <div key={key}>
              <Txt id={`home.m_ledger_${key}_label`} as="dt" />
              <dd>
                {value === undefined ? (
                  <Txt id={`home.m_ledger_${key}_value`} />
                ) : countUp ? (
                  <AnimatedNumber value={value} />
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
        <a
          href={GITHUB_ORG}
          target="_blank"
          rel="noopener noreferrer"
          className="home-mobile-ledger-link"
        >
          <Txt id="home.m_ledger_github" />
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="8 7 17 7 17 16" />
          </svg>
        </a>
      </section>

      <Link
        prefetch="intent"
        to="/products"
        className="home-mobile-browse"
      >
        <Txt id="home.m_browse" />
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </Link>

      <CommunitySection counts={discord} />
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
      <Txt id="home.m_featured_label" as="p" className="section-label" />
      <EarlyBirdNote show={anyEarlyPrice(items)} className="home-mobile-early-note" />
      <div className="home-mobile-grid">
        {items.map((product) => (
          <ProductItem
            key={product.id}
            product={product}
            // Below the fold on a phone: an eager image here was preloaded
            // at high priority and held back the first paint.
            loading="lazy"
          />
        ))}
      </div>
    </section>
  );
}
