import {BOARD_ART_VERSION} from '~/data/board-art-version';
import {Fragment, Suspense, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useAside} from '~/components/Aside';
import {
  Await,
  Link,
  redirect,
  useLoaderData,
  useNavigate,
  useRouteLoaderData,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from 'react-router';
import type {RootLoader} from '~/root';
import type {Route} from './+types/products.$handle';
import {
  byHandle,
  bySku,
  mapProductOptions,
  selectVariant,
  selectedOptionsFromRequest,
  formatPrice,
  toCard,
  toProduct,
} from '~/lib/catalog';
import {buyUrl, commerceHandoff} from '~/lib/shop-links';
import {Txt} from '~/components/Txt';
import {ConceptPlate} from '~/components/ConceptPlate';
import {ProductPrice} from '~/components/ProductPrice';
import {ProductGallery} from '~/components/ProductGallery';
import {ProductSilhouette} from '~/components/ProductSilhouette';
import {ProductForm} from '~/components/ProductForm';
import {RelatedProducts} from '~/components/RelatedProducts';
import {FirmwareSupport} from '~/components/FirmwareSupport';
import {VariantLadder} from '~/components/VariantLadder';
import {BoardArt} from '~/components/BoardArt';
import {SchematicViewer} from '~/components/SchematicViewer';
import type {FrameViewerProps} from '~/components/FrameViewer';
import {SceneErrorBoundary} from '~/components/SceneErrorBoundary';
import {ProvenanceCard} from '~/components/ProvenanceCard';
import {WatchCard} from '~/components/WatchCard';
import {OshwaMark} from '~/components/OshwaMark';
import {ContributorGrid, ContributorGridSkeleton} from '~/components/Contributors';
import {fetchContributors} from '~/lib/github';
import {orderByCredits, snapshotContributors} from '~/lib/contributors-snapshot';
import {CONTRIBUTING_URL} from '~/lib/company';
import {redirectIfHandleIsLocalized} from '~/lib/redirect';
import {copy, copyText, editAttrs} from '~/lib/copy';
import {
  resolveChapters,
  type ChapterEntry,
  type ChapterType,
} from '~/lib/chapters';
import {buildSeoMeta, buildProductJsonLd,
  buildBreadcrumbJsonLd, SITE_ORIGIN} from '~/lib/seo';
import {
  ReviewAggregateLine,
  ReviewList,
  toReviewAggregate,
} from '~/components/ProductReviews';
import {useNoHover, useIsMobile} from '~/lib/use-media-query';
import {GpsrBlock, safetyKind} from '~/components/GpsrBlock';
import {
  PRODUCT_CONTENT,
  WHAT_IS_THIS_ID,
  pageContent,
  specSheet,
  isConceptFor,
  isInternalSku,
  imagesAreRenders,
  isPurchasableStatus,
  variantDisplayName,
  canonicalOptionValue,
} from '~/lib/product-content';
import {useProductStatus} from '~/lib/coming-soon';
import {shipPromiseFor} from '~/lib/preorder';
import {fetchStatusFlagsFast, statusForHandle} from '~/lib/roadmap-data';
import {parseCampaignConfig, priceLadder, tiersFor} from '~/lib/preorder-campaign';
import {stepBarView} from '~/lib/preorder-meter';
import {paysEuVat} from '~/lib/visitor-country';
import {notSoldDirect} from '~/lib/shipping-rates';
import {registrationNumbers} from '~/lib/registrations';
import preorders from '../../content/preorders.json';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';
import {NewsletterSignup} from '~/components/NewsletterSignup';
import {ProductGhostTile} from '~/components/ProductGhostTile';
import {StepBar} from '~/components/PreorderMeter';
import {ShipLine} from '~/components/ShipChip';
import type {
  ChapterPin,
  DownloadAsset,
  DownloadKind,
} from '~/lib/product-content';

/** The campaign (content/preorders.json): each SKU's price steps. */
const CAMPAIGN_CONFIG = parseCampaignConfig(preorders);

/** Fill `{name}` slots in a copy template. */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Copy with a readable fallback while a key is missing from the copy file. */
function say(id: string, fallback: string, vars: Record<string, string | number> = {}): string {
  return fill(copyText(id) ?? fallback, vars);
}

/** Largest quantity one add may ask for: the cart action's per-line cap. */
const MAX_LINE_QUANTITY = 50;

/**
 * Whether a product's design files are public: an open-hardware content file
 * with a repo link on the product or on one of its variants. The frames are
 * open hardware whose repos are still private, so they are not.
 */
function hasPublicRepo(handle: string | null | undefined): boolean {
  const content = handle ? PRODUCT_CONTENT[handle] : undefined;
  if (!content || content.editorial === false) return false;
  return (
    Boolean(content.repoUrl) ||
    Object.values(content.variants ?? {}).some((v) => Boolean(v.repoUrl))
  );
}

/**
 * The page description. Shopify's product description wins, except for
 * open hardware whose repo is still private: its Shopify text names the
 * open-source licence, which the page must not claim until the files are
 * public, so the editorial intro stands in.
 */
function pageDescription(
  handle: string | null | undefined,
  shopify: string | null | undefined,
): string | undefined {
  const content = handle ? PRODUCT_CONTENT[handle] : undefined;
  if (content && content.editorial !== false && !hasPublicRepo(handle)) {
    return content.whatIsThis?.intro || content.hero.lead || undefined;
  }
  return shopify || undefined;
}

export const meta: Route.MetaFunction = ({data, location}) =>
  buildSeoMeta({
    title: data?.product?.seo?.title || data?.product?.title || 'Product',
    description: pageDescription(
      data?.product?.handle,
      data?.product?.seo?.description || data?.product?.description,
    ),
    image: data?.product?.selectedOrFirstAvailableVariant?.image?.url,
    type: 'product',
    // Canonical without the ?Model= query so variant links don't splinter.
    url: `${SITE_ORIGIN}${location.pathname}`,
    // Planned / in-progress products render the concept plate, which is a
    // placeholder, not content worth indexing.
    robots: isConceptFor(data?.product?.handle, data?.roadmapStatus)
      ? 'noindex, follow'
      : undefined,
  });

/**
 * Selecting a SKU only mutates this PDP's option query params (e.g. ?Model=…).
 * Skip the loader on those same-path navigations: re-running it means a
 * catalog round-trip plus a full PDP re-render (3D viewer, chapters) on every
 * click - the source of the variant-switch lag. The
 * variant is resolved client-side from the already-loaded data instead.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname === nextUrl.pathname) return false;
  return defaultShouldRevalidate;
}

export async function loader(args: Route.LoaderArgs) {
  // Start fetching non-critical data without blocking time to first byte
  const deferredData = loadDeferredData(args);

  // Await the critical data required to render initial state of the page
  const criticalData = await loadCriticalData(args);

  return {...deferredData, ...criticalData};
}

/**
 * Load data necessary for rendering content above the fold. This is the critical data
 * needed to render the page. If it's unavailable, the whole page should 400 or 500 error.
 */
async function loadCriticalData({context, params, request}: Route.LoaderArgs) {
  const {handle} = params;

  if (!handle) {
    throw new Error('Expected product handle to be defined');
  }

  // OpenStack is no longer a product: the stack is bought from the FC/ESC
  // pages via the stack builder. Old links land on the FC.
  if (handle === 'openstack') {
    throw redirect('/products/openfc-lite', 301);
  }

  // A link that names a version by its label or another spelling
  // (?Model=5" for the 2207 value) lands on the catalog value instead of
  // silently falling back to the first version.
  const axis = PRODUCT_CONTENT[handle]?.optionAxis;
  if (axis) {
    const url = new URL(request.url);
    const canonical = canonicalOptionValue(handle, url.searchParams.get(axis));
    if (canonical) {
      url.searchParams.set(axis, canonical);
      throw redirect(`${url.pathname}?${url.searchParams.toString()}${url.hash}`, 301);
    }
  }

  // Bundle products render from their own product but add the *component*
  // variants to cart. They come out of the same catalog document as the
  // product itself, so resolving them costs nothing extra.
  const bundleHandles =
    PRODUCT_CONTENT[handle]?.bundle?.components.map((c) => c.handle) ?? [];

  // Roadmap status for the concept plate. The 600ms fast fetch races
  // the GitHub topic lookup against the static ROADMAP fallback, so a cold
  // cache or an API failure degrades to the checked-in status, never a 500.
  const statusFlagsPromise = fetchStatusFlagsFast(
    context.env.GITHUB_STATUS_TOKEN,
    undefined,
    context.waitUntil,
  );

  const catalog = await context.catalog.get();
  const entry = byHandle(catalog, handle);

  if (!entry) {
    throw new Response(null, {status: 404});
  }

  const product = toProduct(
    catalog,
    entry,
    selectedOptionsFromRequest(request),
  );

  // Component products for the bundle lines, from the same catalog: no
  // second round-trip, no second source of prices.
  const bundleProducts = bundleHandles
    .map((h) => byHandle(catalog, h))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => toProduct(catalog, p));

  // Shopify's compare-at price per SKU is the retail price a campaign SKU
  // steps up to. The PDP variant shape drops it for campaign SKUs (no
  // struck-through price, EU art. 6a), so the price ladder reads it here.
  const retailBySku: Record<string, number | null> = Object.fromEntries(
    entry.variants.map((v) => [v.sku, v.compare_price ?? null]),
  );

  return {
    product,
    bundleProducts,
    retailBySku,
    commerceHandoff: commerceHandoff(catalog),
    // The roadmap status this page's boards carry (beta, alpha, ...): a
    // concept renders the concept plate. Undefined for products off the
    // roadmap (accessories).
    roadmapStatus: statusForHandle(handle, await statusFlagsPromise),
  };
}

/**
 * Load data for rendering content below the fold. This data is deferred and will be
 * fetched after the initial page load. If it's unavailable, the page should still 200.
 * Make sure to not throw any errors here, as it will cause the page to 500.
 */
function loadDeferredData({context, params}: Route.LoaderArgs) {
  const {handle} = params;

  if (!handle) {
    return {
      recommendations: Promise.resolve(null),
      contributors: Promise.resolve([]),
    };
  }

  const content = PRODUCT_CONTENT[handle];
  // Optional GITHUB_TOKEN lifts the API ceiling from 60 to 5000 calls an
  // hour; unset, the contributor fetch degrades to its empty state.
  const ghToken = context.env.GITHUB_TOKEN;

  // Contributor grid: every repo in the line (tier repos included) so the
  // section credits people whichever mount they worked on. Same
  // unauthenticated GitHub budget as the commit fetch; edge-cached 1 h in
  // fetchContributors, and the chapter renders its invitation state when
  // the list comes back empty.
  const contributorRepoUrls: string[] = [];
  if (content) {
    if (content.bundle) {
      for (const c of content.bundle.components) {
        const sub = PRODUCT_CONTENT[c.handle];
        if (sub?.repoUrl) contributorRepoUrls.push(sub.repoUrl);
      }
    } else {
      if (content.repoUrl) contributorRepoUrls.push(content.repoUrl);
      for (const v of Object.values(content.variants ?? {})) {
        if (v.repoUrl) contributorRepoUrls.push(v.repoUrl);
      }
    }
  }
  // Oxygen's egress IP is shared, so the unauthenticated GitHub budget is
  // usually spent before a visitor arrives and the fetch 403s. The committed
  // roster (content/contributors.json, weekly sync) is the floor under that:
  // live data still wins, an empty or failed fetch falls back to it instead
  // of leaving the wall with nothing but its invitation tile.
  const recorded = snapshotContributors(handle);
  const contributors = fetchContributors(contributorRepoUrls, 12, ghToken)
    .then((list) => (list.length ? list : recorded))
    .catch(() => recorded);

  // "You might also like": the other products in the catalog. The catalog
  // is small enough that the whole rest of it IS the honest answer.
  const recommendations = context.catalog
    .get()
    .then((catalog) =>
      catalog.products
        .filter((p) => p.handle !== handle)
        .slice(0, 4)
        .map((p) => toCard(catalog, p)),
    )
    .catch(() => null);

  return {recommendations, contributors};
}

const DOWNLOAD_ICONS: Record<DownloadKind, string> = {
  schematic: '▱',
  step: '⬢',
  bom: '☰',
  gerber: '▦',
  manual: '✎',
  wiring: '⎔',
  flash: '⚡',
  changelog: '↻',
  sbom: '◫',
  doc: '✓',
  firmware_manifest: '⌘',
  other: '↓',
};

function DownloadsGrid({
  downloads,
  editBase,
  editableCount = downloads.length,
}: {
  downloads: DownloadAsset[];
  /** Studio tag prefix, `<handle>.downloads`; the grid is per-product. */
  editBase?: string;
  /** Entries at this index or later are computed, not editorial: they get no Studio edit tag, since
   *  `content/products/<handle>.json` has no matching downloads entry to
   *  point at. Defaults to every entry being editable. */
  editableCount?: number;
}) {
  if (downloads.length === 0) return null;
  const edit = (i: number, field: string) =>
    editBase && i < editableCount ? editAttrs(`${editBase}.${i}.${field}`) : {};
  return (
    <div className="downloads-grid">
      {downloads.map((d, i) => (
        <a
          key={d.href}
          href={d.href}
          target="_blank"
          rel="noopener noreferrer"
          className="download-card"
        >
          <span className="download-icon" aria-hidden="true">
            {DOWNLOAD_ICONS[d.kind] ?? DOWNLOAD_ICONS.other}
          </span>
          <span className="download-label" {...edit(i, 'label')}>
            {d.label}
          </span>
          {d.note ? (
            <span className="download-note" {...edit(i, 'note')}>
              {d.note}
            </span>
          ) : null}
          {d.size ? (
            <span className="download-size" {...edit(i, 'size')}>
              {d.size}
            </span>
          ) : null}
          <Txt
            id="product-chrome.download_cta"
            as="span"
            className="download-cta"
            aria-hidden="true"
          />
        </a>
      ))}
    </div>
  );
}

/**
 * The chapters with the buying facts first: after the beginner chapter,
 * Specs and In the box come before the open-source cards, the teardown and
 * the rest. Numbers follow the new order.
 */
function buyingOrder<T extends {type: string; number: string}>(chapters: T[]): T[] {
  const facts = (c: T) => c.type === 'specs' || c.type === 'inTheBox';
  const intro = chapters.filter((c) => c.type === 'whatIsThis');
  const ordered = [
    ...intro,
    ...chapters.filter(facts),
    ...chapters.filter((c) => !facts(c) && c.type !== 'whatIsThis'),
  ];
  return ordered.map((c, i) => ({...c, number: String(i + 1).padStart(2, '0')}));
}

/** DOM ids of the spec and box chapters. */
const SPECS_ID = 'specs';
const IN_THE_BOX_ID = 'in-the-box';

/** "OpenFC-Lite-Mini" from https://github.com/OpenDrone-hw/OpenFC-Lite-Mini. */
function repoName(url: string | null | undefined): string | null {
  const m = url ? /github\.com\/[^/]+\/([^/?#]+)/.exec(url) : null;
  return m ? m[1] : null;
}

/**
 * Client-only loader for the exploded 3D frame viewer. The viewer pulls in
 * three.js + @react-three/fiber, so - like the homepage's HeroScene - we
 * code-split it and import it in the browser only, keeping the r3f runtime
 * out of the server render and the PDP's initial chunk.
 */
function ClientFrameViewer(props: FrameViewerProps) {
  const [Viewer, setViewer] = useState<React.ComponentType<FrameViewerProps> | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    void import('~/components/FrameViewer').then((m) => {
      if (alive) setViewer(() => m.FrameViewer);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!Viewer) return null;
  return <Viewer {...props} />;
}

/** Placeholder media slot. Renders a soft card with a geometric icon
 *  picked from `kind` until real images are wired in. */
function ChapterMediaPlaceholder({kind}: {kind: string}) {
  return (
    <div className="chapter-media-frame" aria-hidden="true">
      <svg
        viewBox="0 0 120 120"
        className="chapter-media-glyph"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === '01' ? (
          <>
            <rect x="22" y="22" width="76" height="76" rx="6" />
            <circle cx="36" cy="36" r="3" />
            <circle cx="84" cy="36" r="3" />
            <circle cx="36" cy="84" r="3" />
            <circle cx="84" cy="84" r="3" />
            <path d="M44 60h32M60 44v32" />
          </>
        ) : kind === '02' ? (
          <>
            <path d="M30 32h60v56H30z" />
            <path d="M30 32l30 18 30-18" />
            <path d="M60 50v38" />
          </>
        ) : kind === '03' ? (
          <>
            <path d="M24 38l36-14 36 14v44L60 96 24 82z" />
            <path d="M24 38l36 14 36-14" />
            <path d="M60 52v44" />
          </>
        ) : kind === '04' ? (
          <>
            <circle cx="60" cy="60" r="34" />
            <path d="M50 50h20M50 70h20M55 50v20M65 50v20" />
          </>
        ) : kind === '05' ? (
          <>
            <rect x="26" y="26" width="68" height="68" rx="4" />
            <path d="M26 46h68M26 66h68M26 86h68" />
            <path d="M46 26v68M66 26v68" />
          </>
        ) : (
          <>
            <path d="M30 32h60v56H30z" />
            <path d="M40 56l12 12 28-28" />
          </>
        )}
      </svg>
    </div>
  );
}

function Chapter({
  number,
  title,
  titleId,
  children,
  media,
  backdrop,
  wideMedia,
  noMedia,
  centered,
  textReveal,
  id,
  wide,
  repoScope,
}: {
  number: string;
  label: string;
  /** Optional anchor id so in-page links (buy-area stars) can target it. */
  id?: string;
  /** Full-width slot rendered below the body + media columns (the teardown's
   *  schematic viewer). Plain flow on mobile, spans both tracks on desktop. */
  wide?: React.ReactNode;
  /** When set, the chapter draws the repo-scope outline around everything it
   *  contains - the visual claim (together with the lead line from the
   *  GitHub-repo card above) that the whole chapter is the contents of the
   *  product's repo. */
  repoScope?: boolean;
  /**
   * The designed title, as a copy id. Rendered straight into the `<h2>` so the
   * heading carries its own studio annotation and its inline `*emphasis*`
   * without an extra wrapper element. `title` (the per-product override from
   * `content/chapters.json`) wins when set.
   */
  titleId?: string;
  title?: React.ReactNode;
  children: React.ReactNode;
  /** When defined, gate the body text's slide-in on this flag (false = held off
   *  to the left, hidden). Used by the teardown so the copy slides in only after
   *  the board layers have flown in. Undefined = no gating (normal reveal). */
  textReveal?: boolean;
  /** Optional live media node - when omitted, the chapter renders the
   *  geometric placeholder glyph for this chapter number. */
  media?: React.ReactNode;
  /** Optional full-bleed, non-interactive layer rendered behind the chapter
   *  content (the exploded frame viewer). When set, the right-hand media
   *  slot is dropped and the text sits on top of this layer. */
  backdrop?: React.ReactNode;
  /** Let the media span the full chapter width below the copy - used for the
   *  wide schematic viewer. */
  wideMedia?: boolean;
  /** Leave the media slot empty for chapters whose content (e.g. the spec
   *  table) needs no image. The grid tracks stay put, so the body column
   *  keeps the same width and left edge as every other chapter. */
  noMedia?: boolean;
  /** Centre the heading and the body as one narrower block (the Specs
   *  chapter's table). */
  centered?: boolean;
}) {
  return (
    <section
      id={id}
      className="chapter"
      data-chapter={number}
      data-centered={centered ? '' : undefined}
      data-backdrop={backdrop ? '' : undefined}
      data-wide-media={wideMedia ? '' : undefined}
      data-no-media={noMedia ? '' : undefined}
      data-repo-scope={repoScope ? '' : undefined}
      data-text-pending={textReveal === false ? '' : undefined}
    >
      {backdrop ? <div className="chapter-backdrop">{backdrop}</div> : null}
      {repoScope ? (
        <Txt
          id="product-chrome.teardown_scope_tag"
          as="span"
          className="chapter-scope-tag"
          aria-hidden="true"
        />
      ) : null}
      <div className="chapter-body-col">
        {title ? (
          <h2 className="chapter-title">{title}</h2>
        ) : titleId ? (
          <Txt id={titleId} as="h2" className="chapter-title" />
        ) : null}
        {children}
      </div>
      {backdrop || noMedia ? null : (
        <aside className="chapter-media">
          {media ? (
            <div className="chapter-media-frame chapter-media-frame--live">
              {media}
            </div>
          ) : (
            <ChapterMediaPlaceholder kind={number} />
          )}
        </aside>
      )}
      {wide ? <div className="chapter-wide">{wide}</div> : null}
    </section>
  );
}

/**
 * Scroll-reveal: walk every `.chapter` on the PDP and toggle `.is-visible`
 * when it enters the viewport. CSS handles the fade/translate.
 *
 * Keyed on the product handle: React Router reuses this Product component
 * across PDP navigations (only `:handle` changes), so a `[]`-dep effect
 * never re-runs and the new product's chapters never get observed → they
 * stay opacity 0. Re-running on handle change rebinds the IO to the new
 * DOM and also clears any `is-visible` left over from the prior product.
 */
function useChapterReveal(key: string) {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const chapters = document.querySelectorAll('.chapter');
    // Reset any stale `is-visible` from a prior PDP so chapters above the
    // fold actually animate in instead of being pre-flagged visible.
    chapters.forEach((el) => el.classList.remove('is-visible'));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            io.unobserve(e.target);
          }
        }
      },
      {rootMargin: '0px 0px -15% 0px', threshold: 0.05},
    );
    chapters.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [key]);
}

export default function Product() {
  const {product, roadmapStatus} = useLoaderData<typeof loader>();
  // Nothing about a planned or in-progress product is settled, so it gets
  // the concept plate instead of a product page (docs/product-status.md),
  // unless its content file says it sells (pre-order frame).
  if (roadmapStatus && isConceptFor(product.handle, roadmapStatus)) {
    return <ConceptPlate title={product.title} status={roadmapStatus} />;
  }
  return <ProductPage />;
}

/** Document-space layout box via the offsetParent chain: unaffected by CSS
 *  transforms, unlike getBoundingClientRect. */
function layoutBox(el: HTMLElement) {
  let top = 0;
  let left = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
    top += n.offsetTop;
    left += n.offsetLeft;
  }
  return {top, left, width: el.offsetWidth, height: el.offsetHeight};
}

function ProductPage() {
  const specsRef = useRef<HTMLDivElement>(null);
  const {
    product,
    bundleProducts,
    retailBySku,
    recommendations,
    contributors,
    commerceHandoff,
  } = useLoaderData<typeof loader>();
  useChapterReveal(product.handle);

  // Lead line: ties the GitHub-repo study card to the repo-scope outline in
  // the chapter below it (maintainer, 2026-08-12). Measured rather than pure CSS
  // because the card's column shifts with which cards a product shows, and
  // the card clips its own pseudo-elements (overflow: hidden). Written as
  // CSS vars on the scope chapter; the ::before there draws the line.
  // Re-measured on resize and once the scope scrolls into view (the reveal
  // translate shifts boxes ~16px until chapters settle).
  useEffect(() => {
    const measure = () => {
      const scope = document.querySelector<HTMLElement>(
        '.chapter[data-repo-scope]',
      );
      const card = document.querySelector<HTMLElement>(
        '.open-source-card--github',
      );
      if (!scope) return;
      // Layout boxes, not getBoundingClientRect: the chapter reveal
      // translates both the card's chapter and the scope, and a rect read
      // mid-transition left the line short or long depending on when the
      // measure ran. offsetTop/offsetLeft ignore transforms entirely, so
      // the timing of the reveal no longer matters.
      const s = layoutBox(scope);
      const c = card ? layoutBox(card) : null;
      const x = c ? c.left + c.width / 2 - s.left : -1;
      const h = c ? s.top - (c.top + c.height) : 0;
      if (c && h > 8 && h < 400 && x > 0 && x < s.width) {
        scope.style.setProperty('--repo-lead-x', `${Math.round(x)}px`);
        scope.style.setProperty('--repo-lead-h', `${Math.round(h)}px`);
      } else {
        scope.style.removeProperty('--repo-lead-x');
        scope.style.removeProperty('--repo-lead-h');
      }
    };
    const t = setTimeout(measure, 900);
    const scope = document.querySelector('.chapter[data-repo-scope]');
    const timers: ReturnType<typeof setTimeout>[] = [];
    let io: IntersectionObserver | undefined;
    if (scope && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(([e]) => {
        // Twice: once as the reveal transform is ending and once well after,
        // because a rect measured mid-translate leaves the line short or
        // long (transforms move rects without resizing anything, so the
        // ResizeObserver below cannot see them).
        if (e.isIntersecting) {
          timers.push(setTimeout(measure, 700), setTimeout(measure, 1500));
        }
      });
      io.observe(scope);
    }
    // One-shot timers miss late layout: images decoding, fonts swapping,
    // fetched sections filling in. All of those change an element's height
    // somewhere above the scope, which shifts the card/scope distance, so a
    // body-size observer catches them; the card observer catches the card
    // itself rewrapping.
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(document.body);
      const card = document.querySelector('.open-source-card--github');
      if (card) ro.observe(card);
    }
    window.addEventListener('resize', measure);
    return () => {
      clearTimeout(t);
      timers.forEach(clearTimeout);
      io?.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [product.handle]);

  // Funnel step 1: one `PDP View` per product per navigation, carrying the
  // product handle + first-touch channel props that aggregate pageviews
  // lack (Plausible pageviews cannot join page path to a custom source
  // prop, so the per-channel funnel needs its own event). Ref guard on
  // the handle: StrictMode's double effect run and unrelated re-renders
  // cannot double-fire; navigating away and back is a fresh view again
  // because the ref updates with the handle.
  const pdpViewTracked = useRef<string | null>(null);
  useEffect(() => {
    if (pdpViewTracked.current === product.handle) return;
    pdpViewTracked.current = product.handle;
    trackEvent('PDP View', {
      props: {product: product.handle, source: attributionSource()},
    });
  }, [product.handle]);

  // Resolve the selected variant client-side from the URL options. Paired with
  // `shouldRevalidate` (above), switching SKUs is instant: no loader
  // round-trip, no full-page revalidation. The candidate list already carries
  // every tier's price/stock for a line product, so we match the URL against it
  // and fall back to the server's default variant when no options are set.
  const [searchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const selectedVariant = useMemo(() => {
    const params = new URLSearchParams(searchKey);
    const wanted = [...params].map(([name, value]) => ({name, value}));
    return (
      selectVariant(product.variants.nodes, wanted) ??
      product.selectedOrFirstAvailableVariant
    );
  }, [searchKey, product]);

  // Coming-soon state: no prices, no add-to-cart - the buy module becomes a
  // notify-at-launch signup. Root data feeds the Turnstile key.
  const rootData = useRouteLoaderData<RootLoader>('root');
  // Lifecycle status drives the buy module: 'idea' and 'development' are
  // both not-purchasable (`soon`), but render different plates; 'preorder'
  // buys like 'live' with the ship promise on the stock line.
  const status = useProductStatus(product.handle);
  const soon = !isPurchasableStatus(status);
  const preorder = status === 'preorder';

  // Get the product options array
  const productOptions = useMemo(
    () =>
      mapProductOptions({
        ...product,
        selectedOrFirstAvailableVariant: selectedVariant,
      }),
    [product, selectedVariant],
  );

  const {title} = product;

  const content = pageContent(product.handle);
  // The Downloads chapter's editorial assets. Declarations of Conformity are
  // internal records: no DoC entry is rendered.
  const downloads = content.downloads;
  // Star aggregate from the catalog's `rating` field. Gated on count > 0, so
  // a product with no published rating renders no trace of the feature.
  const reviewAggregate = toReviewAggregate(product.rating);

  // Comparison-ladder state for product lines (OpenRX/OpenESC). The
  // editorial `variants` map is the tier source of truth; the active tier
  // drives the spec/in-the-box preview and, once Shopify carries the
  // matching option, the buy module follows via the selected variant.
  const variantKeys = content.variants ? Object.keys(content.variants) : [];
  const hasLadder = Boolean(content.optionAxis && variantKeys.length > 0);

  // Compact buy bar (main's): once the top fold's buy module has scrolled
  // under the header, a copy of the variant chips, price and Pre-order pins
  // to the top (a bottom bar under 960px), so a buyer can switch variants
  // from anywhere on the page. Driven by a zero-height sentinel below the
  // in-hero buy module; it steps aside while the footer is on screen.
  // A state ref: the hero can mount after this effect's first run (the
  // phone layout re-renders), and the observer must follow the element.
  const [railSentinel, setRailSentinel] = useState<HTMLDivElement | null>(null);
  const [railPinned, setRailPinned] = useState(false);
  const [footerInView, setFooterInView] = useState(false);
  const [railBox, setRailBox] = useState<{right: number} | null>(null);
  const [railMobile, setRailMobile] = useState(false);
  const {type: asideType} = useAside();
  useEffect(() => {
    if (!hasLadder) return;
    const sentinel = railSentinel;
    const section = sentinel?.closest('.product-hero');
    if (!sentinel || !section) return;
    const HEADER = 56; // --header-height
    const measure = () => {
      // Line the pinned bar's right edge up with the header pill's.
      const headerEl = document.querySelector('.site-header-main');
      const refRight = (headerEl ?? section).getBoundingClientRect().right;
      setRailBox({right: Math.round(document.documentElement.clientWidth - refRight)});
      setRailMobile(!window.matchMedia('(min-width: 960px)').matches);
    };
    measure();
    const io = new IntersectionObserver(
      ([entry]) => setRailPinned(!entry.isIntersecting && entry.boundingClientRect.top < HEADER),
      // Everything below the header line counts as in view, so a jump past
      // the buy module (a phone fling, an anchor link) still flips the state.
      {rootMargin: `-${HEADER}px 0px 100000px 0px`, threshold: 0},
    );
    io.observe(sentinel);
    const footer = document.querySelector('footer');
    const footerIo = footer
      ? new IntersectionObserver(([entry]) => setFooterInView(entry.isIntersecting), {threshold: 0})
      : null;
    if (footer) footerIo?.observe(footer);
    window.addEventListener('resize', measure);
    return () => {
      io.disconnect();
      footerIo?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [railSentinel, hasLadder]);
  const matchKey = (val?: string) =>
    val
      ? variantKeys.find(
          (k) => k.trim().toLowerCase() === val.trim().toLowerCase(),
        )
      : undefined;
  const catalogAxisValue = content.optionAxis
    ? selectedVariant?.selectedOptions?.find(
        (o) =>
          o.name.trim().toLowerCase() ===
          content.optionAxis!.trim().toLowerCase(),
      )?.value
    : undefined;
  const [activeTier, setActiveTier] = useState(
    matchKey(catalogAxisValue) ?? variantKeys[0] ?? '',
  );
  // Re-sync if the catalog resolves a different variant (deep-link with
  // ?Model=Mono, or the optimistic variant settling on another tier).
  useEffect(() => {
    const k = matchKey(catalogAxisValue);
    if (k && k !== activeTier) setActiveTier(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogAxisValue]);
  const activeVariant = content.variants?.[activeTier];
  // The SKU a buyer may see: none when the variant's SKU names a spec that
  // is not final (OPENMOTOR-2207). It stays the internal ID everywhere else.
  const shownSku = isInternalSku(product.handle, catalogAxisValue)
    ? null
    : (selectedVariant?.sku ?? null);

  // Gallery: dedupe by URL and, on tiered products, hide images whose
  // filename OR alt text names a DIFFERENT tier (openesc-20x20-back.png, or
  // alt "OpenRX Mono, top", has no business in another tier's deck).
  // Normalizes '20×20' → '20x20' for the match; images naming no tier
  // (lifestyle shots) always stay, and the selected variant's own featured
  // image always stays. Shopify links at most ONE image per variant, so
  // tagging the rest is a data job: name the file or set the alt text with
  // the tier key on the product in Shopify.
  const galleryImages = useMemo(() => {
    const nodes = product.images?.nodes?.length
      ? product.images.nodes
      : selectedVariant?.image
        ? [selectedVariant.image]
        : [];
    const seen = new Set<string>();
    const deduped = nodes.filter((img) => {
      const key = img.url.split('?')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const tierKeys = content.variants ? Object.keys(content.variants) : [];
    if (tierKeys.length < 2) return deduped;
    const norm = (v: string) =>
      v.trim().toLowerCase().replace(/[×x]/g, 'x').replace(/\s+/g, '');
    const active = norm(activeTier);
    const keys = tierKeys.map(norm).filter(Boolean);
    // Longest-match-wins: tier keys can be substrings of each other
    // (Lite vs Lite-UFL). Naively excluding every other-tier key dropped
    // the Lite-UFL render under its own tier ("lite" matches inside
    // "lite-ufl"), leaving an empty gallery. An image belongs to the
    // longest tier key its filename contains; keep it when that's the
    // active tier or when it names no tier at all.
    // Alt text is free prose ("OpenRX Lite UFL, top"), so its match also
    // ignores hyphens and underscores on both sides; filenames keep the
    // hyphenated key (openesc-20x20-back.png).
    const loose = (v: string) => v.replace(/[-_]/g, '');
    const looseKeys = keys.map(loose);
    const featuredId = selectedVariant?.image?.id ?? null;
    return deduped.filter((img) => {
      if (featuredId && img.id === featuredId) return true;
      const name = img.url.split('?')[0].toLowerCase();
      const alt = loose(norm(img.altText ?? ''));
      const best = keys
        .filter((k, i) => name.includes(k) || alt.includes(looseKeys[i]))
        .sort((a, b) => b.length - a.length)[0];
      return !best || best === active;
    });
  }, [product.images, selectedVariant?.image, content.variants, activeTier]);

  // GitHub links (repo card / issues / latest commit) follow the selected tier:
  // split-repo lines (OpenFC-Lite ↔ OpenFC-Lite-Mini, OpenESC-20x20 ↔
  // OpenESC-30x30) point at the tier's repo, others at the product default.
  const activeRepoUrl = activeVariant?.repoUrl ?? content.repoUrl;
  // Open hardware whose design files are public. A product whose repo is
  // still private (the frames) carries an empty repoUrl: no Open Source
  // chip, no repo or licence cards and no contributor wall, because every
  // one of those would point a buyer at a 404.
  const hasPublicSource = hasPublicRepo(product.handle);
  // OSHWA certification follows the selected tier - each certified board has its
  // own UID, so the chip links to the directory page for the active variant.
  const activeOshwaUid = activeVariant?.oshwaUid ?? content.oshwaUid;
  // The spec-sheet line under the name follows the selected version.
  const subtitle = activeVariant?.subtitle ?? content.subtitle ?? null;
  const sheet = specSheet(content);
  const mergedBox = [...content.inTheBox, ...(activeVariant?.inTheBox ?? [])];
  // Plug and pin-order rows: the tier's own list wins over the product's.
  const activeConnectors = activeVariant?.connectors ?? content.connectors ?? [];
  // Printed circuit boards: the provenance card (designed in Leuven,
  // assembled in Shenzhen) describes these and nothing else.
  const isBoard =
    Boolean(content.teardown?.boardArt) ||
    Object.values(content.variants ?? {}).some((v) => Boolean(v.boardArt));

  // Studio click-to-edit for per-product strings. Copy files get their
  // `data-edit` tag from `<Txt>`/`editAttrs`, but everything rendered out of
  // `content/products/<handle>.json` was untagged, so clicking it in the
  // studio preview did nothing. The id's page segment is the handle; the
  // studio matches it to `products/<handle>` by suffix, and the rest is the
  // leaf path inside that file.
  const prodEdit = (path: string) => editAttrs(`${product.handle}.${path}`);
  // Accessory rows come from content/accessories.json, not a product file
  // the studio can write, so only editorial files get spec edit tags.
  const specsEditable = Boolean(PRODUCT_CONTENT[product.handle]);

  // Bundle (OpenStack): resolve each component's variant for the active size,
  // so add-to-cart drops the real FC + ESC lines and the buy module shows the
  // combined price. The size axis is matched by name ("Model") + the active
  // tier key; a component with no matching variant falls back to its first.
  const bundleComponents = content.bundle?.components ?? [];
  const bundleVariants = bundleComponents.map((c) => {
    const bp = bundleProducts?.find((p) => p?.handle === c.handle);
    const nodes = bp?.variants.nodes ?? [];
    const match = nodes.find((n) =>
      n.selectedOptions?.some(
        (o) =>
          o.name.trim().toLowerCase() === 'model' &&
          o.value.trim().toLowerCase() === activeTier.trim().toLowerCase(),
      ),
    );
    return match ?? nodes[0] ?? null;
  });
  const bundleReady =
    Boolean(content.bundle) && bundleVariants.every((v) => v != null);
  // One multi-line hand-off link for the whole bundle: the shop puts both
  // component SKUs in the cart in a single GET.
  const bundleBuyUrl = bundleReady
    ? buyUrl(
        commerceHandoff,
        bundleVariants.map((v) => ({sku: v!.sku ?? '', quantity: 1})),
      )
    : undefined;
  const bundleAvailable =
    bundleReady && bundleVariants.every((v) => v!.availableForSale);
  const bundlePrice = bundleReady
    ? {
        amount: bundleVariants
          .reduce((s, v) => s + parseFloat(v!.price.amount), 0)
          .toFixed(2),
        currencyCode: bundleVariants[0]!.price.currencyCode,
      }
    : undefined;

  // The teardown board art follows the selected tier: a variant's own
  // `boardArt` wins, otherwise the shared `teardown.boardArt` (the default
  // board) is shown. Lines without per-tier art just keep the default.
  const activeBoardArt = activeVariant?.boardArt ?? content.teardown?.boardArt;
  const silhouetteImage = selectedVariant?.image?.url ?? galleryImages[0]?.url;
  // The teardown pin list follows the tier the same way the board art does:
  // each board in a line has its own refdes layout, so a tier's own `pins`
  // win over the shared `teardown.pins` default. Keeps the hover-highlight
  // refdes matched to the board currently shown.
  // Memoised so its reference is stable per tier - the deferred-swap effect below
  // keys on it and calls setState, so a fresh `?? []` array every render would
  // loop it.
  const activePins = useMemo(
    () => activeVariant?.pins ?? content.teardown?.pins ?? [],
    [activeVariant, content.teardown],
  );
  // Group the teardown pins by board side - Top (front) first, then Bottom
  // (back) - reading each refdes's side from the board's components.json. Done
  // at runtime so it stays accurate per tier with no manual side tagging.
  // Versioned like the board art: /boards/* is cached as immutable.
  const componentsSrc = activeBoardArt?.src.replace(
    /board\.svg$/,
    `components.json${BOARD_ART_VERSION ? `?v=${BOARD_ART_VERSION}` : ''}`,
  );
  const [pinSides, setPinSides] = useState<Map<string, 'F' | 'B'>>(new Map());
  useEffect(() => {
    if (!componentsSrc) return;
    let alive = true;
    fetch(componentsSrc)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const comps =
          (d as {components?: Array<{ref?: string; layer?: string}>})
            ?.components ?? [];
        const m = new Map<string, 'F' | 'B'>();
        for (const c of comps) {
          if (c.ref && (c.layer === 'F' || c.layer === 'B')) m.set(c.ref, c.layer);
        }
        setPinSides(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [componentsSrc]);
  // The teardown list lags a tier swap on purpose. When the board animates a
  // variant change its layers fly across the copy column (the intro cadence),
  // briefly covering the part list - so we hold the OLD pins and switch to the
  // new ones mid-flight, behind the flying boards, instead of snapping the list
  // the instant the tier changes. Reduced-motion (or mobile, where the swap is a
  // quick block slide with no cover) swaps immediately.
  const [displayedPins, setDisplayedPins] = useState(activePins);
  const [pinsSwapping, setPinsSwapping] = useState(false);
  // The component table crossfades on its OWN clock when the pins change - NOT
  // slaved to the board swap. (Tying it to onSwapSettle made the content switch
  // land ~1.1s in, after the dip had already faded back to opacity 1, so the new
  // rows snapped in visibly.) Now: fade out → switch the rows while fully hidden
  // (mid-dip) → fade in. activePins is a memo that only changes identity on a real
  // tier change, so the ref compare fires exactly once per switch.
  const prevPinsRef = useRef(activePins);
  useEffect(() => {
    if (prevPinsRef.current === activePins) return;
    prevPinsRef.current = activePins;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setDisplayedPins(activePins);
      return;
    }
    setPinsSwapping(true);
    // Switch the rows at the dip's hidden trough (44–56% of 0.52s = 229–291ms),
    // then let the dip fade the new rows back in - no visible row snap.
    const tSwap = setTimeout(() => setDisplayedPins(activePins), 235);
    const tDone = setTimeout(() => setPinsSwapping(false), 520);
    return () => {
      clearTimeout(tSwap);
      clearTimeout(tDone);
    };
  }, [activePins]);
  // Studio tag base for the pin list on screen. The displayed list is, by
  // reference, either the shared `teardown.pins` or one tier's own list, so
  // the file path is recovered by identity rather than guessed from the
  // active tier (the list deliberately lags a tier swap).
  const pinEditBase = useMemo(() => {
    if (content.teardown?.pins === displayedPins) return 'teardown.pins';
    for (const [tier, v] of Object.entries(content.variants ?? {})) {
      if (v.pins === displayedPins) return `variants.${tier}.pins`;
    }
    return null;
  }, [displayedPins, content.teardown, content.variants]);
  // Partition pins by the dominant side of their refs. Until the map loads (or
  // for pins with no resolvable side) pins fall into `other`, rendered flat.
  const groupedPins = useMemo(() => {
    const top: ChapterPin[] = [];
    const bottom: ChapterPin[] = [];
    const other: ChapterPin[] = [];
    for (const pin of displayedPins) {
      if (!pin.refs?.length || pinSides.size === 0) {
        other.push(pin);
        continue;
      }
      let f = 0;
      let b = 0;
      for (const r of pin.refs) {
        const s = pinSides.get(r);
        if (s === 'F') f++;
        else if (s === 'B') b++;
      }
      if (f === 0 && b === 0) other.push(pin);
      else if (f >= b) top.push(pin);
      else bottom.push(pin);
    }
    return {top, bottom, other};
  }, [displayedPins, pinSides]);
  // Flat tour order for the mobile "swipe the board sideways to step through the
  // parts" gesture - front parts top→bottom, then back, then any unsided. Each
  // carries its full highlight spec (the same one its table row uses). Chip rows
  // (I/O pads) expand to one stop per chip.
  type TourPart = {
    refs: string[];
    union: boolean;
    groups?: string[][];
    name: string;
    cost?: string;
  };
  // Split the tour into a top-side row and a bottom-side row (mobile shows them
  // as two chip rows). Unsided pins ride along with the bottom row.
  const partRows = useMemo(() => {
    const toParts = (pins: ChapterPin[]) => {
      const out: TourPart[] = [];
      for (const pin of pins) {
        if (pin.chips?.length) {
          for (const chip of pin.chips)
            if (chip.refs?.length)
              out.push({
                refs: chip.refs,
                union: false,
                name: chip.label,
                cost: copyText('product-chrome.teardown_io_tag'),
              });
        } else if (pin.refs?.length) {
          out.push({
            refs: pin.refs,
            union: pin.box === 'union',
            groups: pin.boxGroups,
            name: pin.part,
            cost: pin.cost ?? '×1',
          });
        }
      }
      return out;
    };
    return {
      top: toParts(groupedPins.top),
      bottom: toParts([...groupedPins.bottom, ...groupedPins.other]),
    };
  }, [groupedPins]);
  const orderedParts = useMemo(
    () => [...partRows.top, ...partRows.bottom],
    [partRows],
  );
  const isMobile = useIsMobile();
  // CAD products (the frame) carry an exploded 3D viewer instead of a
  // layered board SVG; when present it takes the teardown media slot. Like
  // boardArt, a tier's own model (3" vs 5") wins over the shared default.
  const frameViewer = activeVariant?.frameViewer ?? content.teardown?.frameViewer;
  // Every frame model across all tiers, so the viewer can preload them and
  // switch tiers instantly (toggle visibility) instead of re-fetching the
  // multi-MB GLB on each swap.
  const frameViewerSrcs = useMemo(() => {
    const set = new Set<string>();
    if (content.teardown?.frameViewer) set.add(content.teardown.frameViewer.src);
    for (const v of Object.values(content.variants ?? {})) {
      if (v.frameViewer) set.add(v.frameViewer.src);
    }
    return [...set];
  }, [content]);
  // Every tier's board SVG, so BoardArt can warm them all and a tier toggle
  // swaps in instantly instead of refetching + flashing blank.
  const boardArtSrcs = useMemo(() => {
    const set = new Set<string>();
    if (content.teardown?.boardArt) set.add(content.teardown.boardArt.src);
    for (const v of Object.values(content.variants ?? {})) {
      if (v.boardArt) set.add(v.boardArt.src);
    }
    return [...set];
  }, [content]);
  // The schematic viewer follows the same board as the layer viewer - its
  // sheets live at /schematics/<board-handle>/ (same handle as the board art).
  const schematicHandle =
    activeBoardArt?.src.match(/\/boards\/([^/]+)\//)?.[1] ?? null;
  // Every tier's schematic handle (derived from its board src), so the viewer
  // can warm sibling manifests + sheets and a tier toggle swaps in instantly.
  const schematicHandles = useMemo(
    () =>
      boardArtSrcs
        .map((s) => s.match(/\/boards\/([^/]+)\//)?.[1])
        .filter((h): h is string => Boolean(h)),
    [boardArtSrcs],
  );

  // Refdes of the teardown pin the visitor is hovering/focusing - highlighted
  // on the board by BoardArt. Lives here (the common ancestor of the pin list
  // and the board) so a hover lights the matching footprint.
  const [hoveredRefs, setHoveredRefs] = useState<string[]>([]);
  // Whether the current highlight is actually drawn on the visible layer (fed by
  // BoardArt). A part can be "selected" but hidden if you've flicked to another
  // layer - used so a re-tap re-asserts instead of toggling an invisible part off.
  const [highlightVisible, setHighlightVisible] = useState(false);
  // On touch there's no hover: a tap emits synthetic mouseenter→...→mouseleave/
  // blur, so the hover handlers would light the part then instantly clear it.
  // Switch to a tap-only model on touch (click toggles; no auto-clear).
  const noHover = useNoHover();
  // Whether the hovered pin wants ONE union box (dense arrays) vs a box per part.
  const [hoveredUnion, setHoveredUnion] = useState(false);
  // Per-group boxes (e.g. ESC motor pads → one box per motor), if the pin sets them.
  const [hoveredGroups, setHoveredGroups] = useState<string[][] | undefined>(
    undefined,
  );
  // True while the board's first-reveal fly-in is animating - locks the parts
  // list so a hover can't fight the animation.
  const [boardFlying, setBoardFlying] = useState(false);
  // The teardown text slides in from the left AFTER the board layers finish
  // flying in: flip `textIn` when the fly completes (boardFlying true→false), with
  // a fallback so it always reveals even if the board never flies (reduced motion
  // / never centred).
  const [textIn, setTextIn] = useState(false);
  // Slide the teardown copy in from the left once the section is actually on
  // screen - a beat after it centres (the board's layers are flying in), so it
  // reads like a final layer. Driven by the section's OWN visibility (not a blind
  // timer, which fired before the user scrolled down → the slide played offscreen
  // and was never seen).
  useEffect(() => {
    // Re-arm on every product switch (the PDP stays mounted across nav, so this
    // must reset or the new product's copy would already be "in").
    setTextIn(false);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setTextIn(true);
      return;
    }
    const el = document.querySelector('.teardown-sides');
    if (!el) {
      setTextIn(true); // no teardown list to gate
      return;
    }
    let timer = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          timer = window.setTimeout(() => setTextIn(true), 600);
        }
      },
      {rootMargin: '-40% 0px -40% 0px'},
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [product.handle]);
  // Co-trigger: the board's own fly starting is a sure sign the teardown is on
  // screen, so slide the copy in a beat later too (belt-and-suspenders with the
  // observer above - textIn latches, so whichever fires first wins).
  useEffect(() => {
    if (!boardFlying) return;
    const t = setTimeout(() => setTextIn(true), 600);
    return () => clearTimeout(t);
  }, [boardFlying]);
  // BoardArt remounts on a product switch while the PDP stays mounted, so
  // reset the fly-in flag for the incoming board.
  useEffect(() => {
    setBoardFlying(false);
  }, [product.handle]);
  // Clear all hover highlight state. Called only when the pointer leaves the
  // whole list (not between rows) so the spotlight stays lit and just moves from
  // row to row - no off/on flicker crossing the dividers/gaps.
  const clearHover = () => {
    setHoveredRefs([]);
    setHoveredUnion(false);
    setHoveredGroups(undefined);
  };
  // Is this part the one currently lit on the board (its chip shows as active)?
  const partLit = (p: TourPart) =>
    p.refs.length === hoveredRefs.length &&
    p.refs.every((r) => hoveredRefs.includes(r));
  // One teardown-pin <li>: the part label (+ optional count); hover/focus
  // highlights its footprint(s) on the board (keyboard mirrors mouse for a11y).
  const renderPin = (pin: ChapterPin) => {
    const refs = pin.refs;
    const pinIdx = displayedPins.indexOf(pin);
    const pinEdit = (field: string) =>
      pinEditBase && pinIdx >= 0
        ? prodEdit(`${pinEditBase}.${pinIdx}.${field}`)
        : {};
    // Chip-row pin (e.g. FC I/O pads): one row, a horizontal set of chips, each
    // highlighting its own pad group on hover/focus.
    if (pin.chips?.length) {
      return (
        <li key={pin.ref} className="teardown-pin teardown-io-row">
          <Txt
            id="product-chrome.teardown_io_tag"
            as="span"
            className="teardown-io-tag"
          />
          <div className="teardown-io-chips">
            {pin.chips.map((chip, chipIdx) => {
              const chipActive =
                hoveredRefs.length === chip.refs.length &&
                chip.refs.every((r) => hoveredRefs.includes(r));
              const on = () => {
                // Fresh array each tap so BoardArt's auto-flip effect re-fires -
                // re-tapping a part hidden under another layer flips back to it.
                setHoveredRefs([...chip.refs]);
                setHoveredUnion(false);
                setHoveredGroups(undefined);
              };
              // Touch: tap toggles this chip's spotlight. Only toggle OFF when
              // it's actually lit on the visible layer - otherwise (you've
              // flicked to another layer) re-tap re-asserts + flips to its face.
              const chipHandlers = noHover
                ? {
                    onClick: () =>
                      chipActive && highlightVisible ? clearHover() : on(),
                  }
                : {onMouseEnter: on, onFocus: on, onBlur: clearHover};
              return (
                <button
                  type="button"
                  key={chip.label}
                  className={`teardown-io-chip${chipActive ? ' is-active' : ''}`}
                  {...chipHandlers}
                  {...pinEdit(`chips.${chipIdx}.label`)}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        </li>
      );
    }
    const hoverable = !!refs?.length;
    const enter = () => {
      // Fresh array each tap so BoardArt's auto-flip effect re-fires even on the
      // same part - re-tapping one hidden under another layer flips back to it.
      setHoveredRefs(refs ? [...refs] : []);
      setHoveredUnion(pin.box === 'union');
      setHoveredGroups(pin.boxGroups);
    };
    // Is this row's footprint set the one currently lit? (used for tap-toggle)
    const isActive =
      hoverable &&
      hoveredRefs.length === refs!.length &&
      refs!.every((r) => hoveredRefs.includes(r));
    // Touch has no hover: a tap toggles this row's spotlight on/off. On desktop
    // the click toggle is harmless - hover already drives the highlight.
    // Toggle OFF only when actually lit on the visible layer; otherwise re-tap
    // re-asserts (and BoardArt flips to the part's face) - no invisible dead tap.
    const tap = () => (isActive && highlightVisible ? clearHover() : enter());
    // No per-row onMouseLeave - clearing happens on the container leave so the
    // spotlight stays lit while moving between rows (onBlur covers keyboard).
    // On touch, drop every hover/focus handler - a tap's synthetic mouse +
    // blur events would clear the spotlight the click just set. Click alone
    // toggles, and it persists (no container mouseleave on touch either).
    const handlers = !hoverable
      ? {}
      : noHover
        ? {onClick: tap, tabIndex: 0}
        : {
            onMouseEnter: enter,
            onClick: tap,
            onFocus: enter,
            onBlur: clearHover,
            tabIndex: 0,
          };
    return (
      <li
        key={pin.ref}
        className={
          hoverable
            ? `teardown-pin teardown-pin-hoverable${isActive ? ' is-active' : ''}`
            : undefined
        }
        {...handlers}
      >
        <span className="teardown-pin-part" {...pinEdit('part')}>
          {pin.part}
        </span>
        <span
          className="teardown-pin-cost"
          {...(pin.cost ? pinEdit('cost') : {})}
        >
          {pin.cost ?? '×1'}
        </span>
      </li>
    );
  };
  // While a component is highlighted, dim the rest of the page a touch (light
  // mode) so the eye is drawn to the board - a focus accent. Toggled via a class
  // on <html> so the dim (an ::after overlay) + the board's lift are pure CSS.
  useEffect(() => {
    const on = hoveredRefs.length > 0;
    document.documentElement.classList.toggle('board-focus', on);
    return () => document.documentElement.classList.remove('board-focus');
  }, [hoveredRefs]);
  // Bundles advertise the composed component price (what add-to-cart actually
  // charges), not a single component's price. Coming soon: no
  // offer at all: structured data must not leak a price the page hides.
  const jsonLdPrice = soon
    ? undefined
    : content.bundle
      ? bundlePrice
      : selectedVariant?.price;
  const productJsonLd = buildProductJsonLd({
    title: product.title,
    description: pageDescription(product.handle, product.description) ?? '',
    imageUrl: selectedVariant?.image?.url ?? galleryImages[0]?.url ?? null,
    url: `${SITE_ORIGIN}/products/${product.handle}`,
    vendor: product.vendor,
    sku: shownSku,
    price: jsonLdPrice
      ? {
          amount: jsonLdPrice.amount,
          currencyCode: jsonLdPrice.currencyCode,
        }
      : null,
    availableForSale: content.bundle
      ? bundleAvailable
      : (selectedVariant?.availableForSale ?? false),
    preorder,
    productHandle: product.handle,
    // AggregateRating rides only when reviews are enabled and count > 0 -
    // same gate as the visible stars, so the structured data never claims
    // ratings the page doesn't show.
    rating: reviewAggregate,
  });
  // Structured data for the whole product, not only the selected variant:
  // the canonical URL carries no ?Model=, so a multi-variant product
  // publishes one AggregateOffer with an Offer per variant. A campaign
  // price holds only until its step's units are sold, never to a date, so
  // preorder offers carry no priceValidUntil.
  const offerBase = productJsonLd.offers as Record<string, unknown> | undefined;
  if (offerBase && preorder) delete offerBase.priceValidUntil;
  const offerNodes = product.variants.nodes;
  if (offerBase && !content.bundle && offerNodes.length > 1) {
    const availabilityOf = (v: (typeof offerNodes)[number]) =>
      !v.availableForSale
        ? 'https://schema.org/OutOfStock'
        : v.availability === 'preorder'
          ? 'https://schema.org/PreOrder'
          : 'https://schema.org/InStock';
    const amounts = offerNodes.map((v) => Number(v.price.amount));
    const currency = offerNodes[0].price.currencyCode;
    productJsonLd.offers = {
      '@type': 'AggregateOffer',
      priceCurrency: currency,
      lowPrice: Math.min(...amounts).toFixed(2),
      highPrice: Math.max(...amounts).toFixed(2),
      offerCount: offerNodes.length,
      offers: offerNodes.map((v) => ({
        ...offerBase,
        name: variantDisplayName(product.handle, v.title),
        sku: isInternalSku(product.handle, v.title) ? undefined : (v.sku ?? undefined),
        price: v.price.amount,
        priceCurrency: v.price.currencyCode,
        availability: availabilityOf(v),
        url: v.selectedOptions.length
          ? `${SITE_ORIGIN}/products/${product.handle}?${new URLSearchParams(
              v.selectedOptions.map((o) => [o.name, o.value]),
            ).toString()}`
          : `${SITE_ORIGIN}/products/${product.handle}`,
      })),
    };
    delete productJsonLd.sku;
  }

  // The ladder + buy module, rendered once in the hero in normal flow.
  // Ladder clicks are the PDP's main variant switch: track them as
  // `Variant Select` (user-initiated only; deep links and catalog
  // re-syncs go through setActiveTier directly and stay silent). Only an
  // actual change counts: the ladder fires onSelect for clicks on the
  // already-active tier too, and re-clicks are not selections.
  const selectTier = (value: string) => {
    if (value !== activeTier) {
      trackEvent('Variant Select', {
        props: {
          product: product.handle,
          variant: value,
          source: attributionSource(),
        },
      });
    }
    setActiveTier(value);
  };
  const railLadder =
    hasLadder && content.optionAxis && content.variants ? (
      <VariantLadder
        axis={content.optionAxis}
        variants={content.variants}
        productOptions={productOptions}
        activeValue={activeTier}
        onSelect={selectTier}
        showPrices={!soon}
      />
    ) : null;
  // A Specs column header selects its version the way a ladder button does:
  // preview at once, then select the catalog variant through the URL.
  const navigate = useNavigate();
  const pickTier = (value: string) => {
    if (content.variants?.[value]?.comingSoon) return;
    selectTier(value);
    const norm = (s: string) => s.trim().toLowerCase();
    const option = productOptions
      .find((o) => norm(o.name) === norm(content.optionAxis ?? ''))
      ?.optionValues.find((v) => norm(v.name) === norm(value));
    if (option?.variantUriQuery && !option.selected) {
      void navigate(`?${option.variantUriQuery}`, {replace: true, preventScrollReset: true});
    }
  };
  // The pinned bar's chips: names only, its buy module carries the price.
  const railLadderPinned =
    hasLadder && content.optionAxis && content.variants ? (
      <VariantLadder
        axis={content.optionAxis}
        variants={content.variants}
        productOptions={productOptions}
        activeValue={activeTier}
        onSelect={selectTier}
      />
    ) : null;
  const isBundle = Boolean(content.bundle);
  // The ship promise shown on the buy module: the catalog's per-product word
  // (frozen onto the order line and printed in the order mail by the same
  // module) when the catalog carries one, else the local content file's
  // note. One string, so the promise the customer reads is the promise on
  // the contract.
  //
  // A variant that carries the key decides, INCLUDING when it decides `null`.
  // The closed-storefront policy (SHOPIFY_PREVIEW_POLICY_JSON) sets
  // `shipPromise: null` on every sold_out SKU on purpose, and
  // app/lib/shopify-storefront.ts refuses to build a closed SKU that carries
  // one. `??` treated that deliberate null as "no opinion" and fell through to
  // the content file, republishing a dispatch date the policy had just
  // withdrawn. Only an absent key falls back.
  const shipPromise = shipPromiseFor(
    selectedVariant?.shipPromise,
    content.statusNote,
  );
  const buyPrice = isBundle ? bundlePrice : selectedVariant?.price;
  const buyAvailable = isBundle
    ? bundleAvailable
    : Boolean(selectedVariant?.availableForSale);

  // Preorder campaign of the selected variant: the price ladder, the ship
  // terms and the quantity cap all read it.
  const campaign = !isBundle && preorder ? (selectedVariant?.campaign ?? null) : null;
  const retail = selectedVariant?.sku ? (retailBySku[selectedVariant.sku] ?? null) : null;
  const tiers = tiersFor(CAMPAIGN_CONFIG, selectedVariant?.sku ?? '');
  // A flat-price SKU (an accessory shipping with a campaign SKU) has no
  // steps: no ladder, no step bar, no Early bird.
  const ladder =
    campaign && tiers.length && retail != null && retail > 0 ? priceLadder(retail, tiers) : null;
  const currency = selectedVariant?.price.currencyCode ?? 'EUR';
  // Batch progress with its price schedule available on demand.
  const nextUnit = campaign ? campaign.ordered + 1 : 0;
  const stepPrices = (ladder ?? []).map((step) => ({
    key: step.from,
    text: formatPrice(step.price, currency),
    range: step.to === null ? `${step.from}+` : `${step.from}-${step.to}`,
    current: nextUnit >= step.from && (step.to === null || nextUnit <= step.to),
  }));
  const stepBarState =
    campaign && tiers.length ? stepBarView(campaign, tiers.map((tier) => tier.upTo)) : null;
  const stepBar =
    campaign && stepBarState ? (
      <StepBar
        bar={stepBarState}
        prices={stepPrices}
        fundedLabel={copyText('preorder.funded') ?? 'Target reached'}
      />
    ) : null;
  // Units left in the paid batch: one add must not ask for more than the
  // batch that carries the ship date still holds.
  const paidLeft = campaign?.paidStock
    ? (campaign.paidLeft ?? campaign.batchUnits - campaign.batchOrdered)
    : null;
  const maxQuantity =
    paidLeft != null ? Math.max(1, Math.min(MAX_LINE_QUANTITY, paidLeft)) : MAX_LINE_QUANTITY;
  // The buy module's quantity, reset whenever the variant changes.
  // A product sold singly but used in sets (4 motors per quad) starts at
  // one set; the stepper still moves by one.
  const setOf = !isBundle && content.setOf && content.setOf > 1 ? content.setOf : null;
  const [quantity, setQuantity] = useState(setOf ?? 1);
  useEffect(() => {
    setQuantity(setOf ?? 1);
  }, [selectedVariant?.id, setOf]);
  const buyQuantity = Math.min(quantity, maxQuantity);
  // Why the stepper stops: the per-order cap, or the units left in the
  // paid batch when fewer remain.
  const maxQuantityNote =
    maxQuantity < MAX_LINE_QUANTITY
      ? say('product-chrome.buy_qty_max_batch', '{count} left in this batch', {count: maxQuantity})
      : say('product-chrome.buy_qty_max', 'Max {count} per order', {count: maxQuantity});

  // Inside the EU the price includes 21% Belgian VAT. Outside it the same
  // euro price applies with no EU VAT charged on the export, so nothing is
  // printed next to it. Shipping is shown at checkout only.
  const vatNote = paysEuVat(rootData?.visitorCountry ?? null)
    ? say('product-chrome.buy_vat_note', 'incl. VAT')
    : null;
  // Consumers buy direct only in the open EU countries. Elsewhere the buy
  // button is a status line (AddToCartButton): outside the EU "EU consumer
  // orders only" with a link to the trade page, in an EU country not open
  // yet "Orders are not open for <country>"; both with the launch-news
  // signup instead of the ship date. A blocked country gets "Not available
  // in <country>" and the End-Use Policy link, with no signup.
  const notDirect = notSoldDirect(rootData?.visitorCountry ?? null);
  // Coming-soon buy module: the price/stock/add-to-cart block becomes a
  // COMING SOON plate + notify-at-launch signup (same newsletter action,
  // tagged with this product's handle). Everything else on the PDP stays.
  const railBuyModule = soon ? (
    <div
      className={`product-buy is-comingsoon${status === 'idea' ? ' is-idea' : ''}`}
      data-buy-module
    >
      <div className="product-buy-price">
        <Txt
          id={
            status === 'idea'
              ? 'product-chrome.buy_status_concept'
              : 'product-chrome.buy_status_soon'
          }
          as="span"
          className="product-buy-soon"
          aria-label={copyText(
            status === 'idea'
              ? 'product-chrome.buy_status_concept'
              : 'product-chrome.buy_status_soon',
          )}
        />
        {shipPromise ? (
          <span className="product-buy-sku" {...prodEdit('statusNote')}>
            {shipPromise}
          </span>
        ) : shownSku ? (
          <span className="product-buy-sku">
            {copyText('product-chrome.buy_sku_prefix')}{' '}
            {shownSku}
          </span>
        ) : null}
      </div>
      {status === 'idea' ? (
        <Txt
          id="product-chrome.buy_idea_pitch"
          as="p"
          className="product-buy-idea-pitch"
        />
      ) : null}
      <NewsletterSignup
        notify={{productHandle: product.handle, productTitle: product.title}}
        turnstileSiteKey={rootData?.turnstileSiteKey ?? null}
        className="product-buy-notify"
      />
      {status === 'idea' ? (
        <a
          className="product-buy-idea-repo"
          href={content.repoUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {copyText('product-chrome.buy_idea_repo_cta')}
        </a>
      ) : null}
    </div>
  ) : (
    <div className="product-buy" data-buy-module>
      <div className="product-buy-price">
        {/* Price + "incl. VAT" (art. VI.45 WER pre-contractual info). */}
        <span className="product-buy-amount">
          <ProductPrice price={buyPrice} />
          {content.priceUnit && !isBundle ? (
            <span className="product-buy-unit" {...prodEdit('priceUnit')}>
              {content.priceUnit}
            </span>
          ) : null}
          {vatNote ? <span className="product-buy-vat">{vatNote}</span> : null}
          {campaign?.earlyPrice && ladder ? (
            <span className="product-buy-tag">
              {say('product-chrome.buy_early_bird', 'Price step 1')}
            </span>
          ) : null}
        </span>
        {isBundle ? (
          (() => {
            // Name the actual pair for the tier (20×20 ships the Mini).
            const hs = content.variants?.[activeTier]?.highlights;
            const hi = hs?.findIndex(([k]) => k === 'Pair') ?? -1;
            return (
              <span
                className="product-buy-sku"
                {...(hi >= 0
                  ? prodEdit(`variants.${activeTier}.highlights.${hi}.1`)
                  : {})}
              >
                {hs?.[hi]?.[1] ?? `OpenFC-Lite + OpenESC · ${activeTier}`}
              </span>
            );
          })()
        ) : null}
      </div>
      {stepBar}
      {/* Star aggregate + link to the reviews chapter. Renders nothing
          without reviews. */}
      <ReviewAggregateLine aggregate={reviewAggregate} />
      <ProductForm
        productOptions={productOptions}
        selectedVariant={selectedVariant}
        hideOptionNames={content.optionAxis ? [content.optionAxis] : undefined}
        buyUrl={isBundle ? (bundleBuyUrl ?? '') : undefined}
        buyDisabled={isBundle ? !bundleAvailable : undefined}
        buyCtaLabel={
          isBundle ? copyText('product-chrome.buy_bundle_cta') : undefined
        }
        quantity={isBundle ? undefined : buyQuantity}
        maxQuantity={maxQuantity}
        maxQuantityNote={maxQuantityNote}
        onQuantityChange={isBundle || notDirect ? undefined : setQuantity}
      />
      {notDirect === 'blocked' ? (
        <p className="product-buy-ship">
          <Link prefetch="intent" to="/end-use" className="product-buy-terms-link">
            {say('product-chrome.buy_blocked_link', 'End-Use Policy')}
          </Link>
        </p>
      ) : notDirect ? (
        <>
          {notDirect === 'shops' ? (
            <p className="product-buy-ship">
              <Link prefetch="intent" to="/wholesale" className="product-buy-terms-link">
                {say('product-chrome.buy_shops_trade', 'EU or US retailer enquiries')}
              </Link>
            </p>
          ) : null}
          <NewsletterSignup
            notify={{productHandle: product.handle, productTitle: product.title}}
            turnstileSiteKey={rootData?.turnstileSiteKey ?? null}
            className="product-buy-notify"
          />
        </>
      ) : /* Ship date right under the button (WER VI.43), and for a funding
          target its deadline and the "if funded" condition. */
      preorder && !isBundle ? (
        <ShipLine campaign={campaign} promise={shipPromise} className="product-buy-stock" />
      ) : (
        <p className={`product-buy-stock${buyAvailable ? '' : ' is-out'}`}>
          {isBundle
            ? copyText(
                buyAvailable
                  ? 'product-chrome.buy_stock_bundle_in'
                  : 'product-chrome.buy_stock_bundle_out',
              )
            : selectedVariant?.availableForSale
              ? copyText('product-chrome.buy_stock_in')
              : shipPromise
                ? (
                    <>
                      {copyText('product-chrome.buy_stock_out') ?? ''} ·{' '}
                      <span {...prodEdit('statusNote')}>{shipPromise}</span>
                    </>
                  )
                : copyText('product-chrome.buy_stock_out')}
        </p>
      )}
      {preorder && !isBundle && !notDirect ? (
        <p className="product-buy-ship">
          <Link prefetch="intent" to="/preorder" className="product-buy-terms-link">
            {say('product-chrome.buy_terms_link', 'Pre-order terms')}
          </Link>
        </p>
      ) : null}
      {/* Sold-out signup: not for pre-order products, whose "unavailable"
          is a catalog availability state, not a launch to be notified of. */}
      {!isBundle &&
      !preorder &&
      !notDirect &&
      selectedVariant &&
      !selectedVariant.availableForSale ? (
        <NewsletterSignup
          notify={{productHandle: product.handle, productTitle: product.title, restock: true}}
          turnstileSiteKey={rootData?.turnstileSiteKey ?? null}
          className="product-buy-notify"
        />
      ) : null}
    </div>
  );

  /** Copy id behind a free-text chapter: one pair of strings per chapter id. */
  const proseKey = (id: string | undefined, part: 'title' | 'body') =>
    `products.${product.handle}.${id ?? ''}_${part}`;

  /**
   * Does a chapter of this type have anything to show on THIS product?
   *
   * These are the conditions that used to gate each inline block, unchanged.
   * They stay in the route rather than moving into the config because their
   * answers come from three places `content/chapters.json` cannot see: whether
   * the handle has an editorial entry at all, the product's lifecycle status,
   * and the catalog's rating.
   */
  const present = (type: ChapterType, entry: ChapterEntry): boolean => {
    switch (type) {
      // Only when the product's JSON carries the beginner copy: accessories
      // and bundles have no `whatIsThis` block and skip the chapter cleanly.
      case 'whatIsThis':
        return Boolean(content.whatIsThis);
      // Accessories (fallback content) aren't open-hardware products - no
      // "Open for learning" chapter, and no chapter number burnt on it.
      // Open hardware whose repo is still private (the frames) has no
      // public files to study yet.
      case 'openSource':
        return hasPublicSource;
      case 'teardown':
        return Boolean(content.teardown);
      case 'specs':
        return content.specs.length > 0;
      case 'inTheBox':
        return content.inTheBox.length > 0 || Boolean(content.bundle);
      case 'downloads':
        return downloads.length > 0;
      // The firmware credit needs no price, so it shows even while the
      // product is coming soon.
      case 'firmware':
        return (
          !content.bundle &&
          Boolean(content.firmware.project) &&
          content.firmware.project !== '-'
        );
      // Every editorial product has a public repo, so the chapter always exists
      // for them - the grid degrades to the "+ you" invitation when the GitHub
      // API is rate-limited.
      case 'contributors':
        return hasPublicSource;
      // Only when the feature is enabled AND the synced metafields carry at
      // least one rating, so a zero-review store shows no trace of it.
      case 'reviews':
        return Boolean(reviewAggregate);
      // A free-text chapter exists once it has words. Keyed by the chapter's
      // id, so several of them on one page stay distinct.
      case 'prose':
        return copy(proseKey(entry.id, 'body')) !== undefined;
      default:
        return false;
    }
  };

  /**
   * How each chapter type draws itself.
   *
   * The data model picks which of these run and in what order; it does not pick
   * how they look. `n` is the number `resolveChapters` assigned from position,
   * so it cannot drift from the render order. `title` is the studio's optional
   * override - absent, the designed title (inline `<em>` and all) stands.
   */
  const chapterNodes: Partial<
    Record<
      ChapterType,
      (n: string, title?: string, id?: string) => React.ReactNode
    >
  > = {
    /**
     * Beginner orientation. What the part IS in plain language, what else a
     * first build needs before it flies, and where it sits in the whole
     * drone. Per-product words live in `content/products/<handle>.json`
     * (`whatIsThis`); the framing strings are product-chrome copy. noMedia:
     * this chapter is a calm read, not a showpiece, and the placeholder
     * glyph would out-shout the words.
     */
    whatIsThis: (n, title) => {
      const wit = content.whatIsThis;
      if (!wit) return null;
      // The signal chain, in hero-scroll order. The product's own stage is
      // lit; stages we sell link their product page, the rest are plain.
      // This strip is the interface to the homepage story: same parts, same
      // order, one screen instead of one scroll.
      const chain: Array<{id: string; copy: string; to?: string}> = [
        {id: 'radio', copy: 'what_chain_radio'},
        {id: 'rx', copy: 'what_chain_receiver', to: '/products/openrx'},
        {id: 'fc', copy: 'what_chain_fc', to: '/products/openfc-lite'},
        {id: 'esc', copy: 'what_chain_esc', to: '/products/openesc'},
        {id: 'motors', copy: 'what_chain_motors', to: '/products/openmotor'},
        {id: 'frame', copy: 'what_chain_frame', to: '/products/openframe'},
      ];
      return (
        <Chapter
          id={WHAT_IS_THIS_ID}
          number={n}
          label="What is this"
          title={title}
          titleId="product-chrome.ch_what_is_this_title"
          noMedia={!content.video}
          media={
            content.video ? (
              // The go-to source: the maintainer's own explainer video for
              // this exact board type carries the depth; the chapter stays a
              // quick orientation.
              <WatchCard
                videoId={content.video.id}
                title={content.video.title}
                channel={content.video.channel}
              />
            ) : undefined
          }
        >
          <p className="chapter-body" {...prodEdit('whatIsThis.intro')}>
            {wit.intro}
          </p>
          <div className="what-chain" aria-label={copyText('product-chrome.what_chain_aria')}>
            {chain.map((c, i) => {
              const active = wit.chain === c.id;
              const chip =
                c.to && !active ? (
                  <Link
                    key={c.id}
                    prefetch="intent"
                    to={c.to}
                    className="what-chain-chip"
                  >
                    <Txt id={`product-chrome.${c.copy}`} />
                  </Link>
                ) : (
                  <span
                    key={c.id}
                    className={`what-chain-chip${active ? ' is-active' : ' is-plain'}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Txt id={`product-chrome.${c.copy}`} />
                  </span>
                );
              return (
                <span key={c.id} className="what-chain-step">
                  {i > 0 ? (
                    <span className="what-chain-arrow" aria-hidden="true">
                      →
                    </span>
                  ) : null}
                  {chip}
                </span>
              );
            })}
          </div>
          {/* The "before this flies you also need" list moved out of the
              chapter (maintainer, 2026-08-12): that story belongs to a general
              FPV intro page, planned. The data stays in whatIsThis.needs
              for that page. */}
          {/* The homepage hero walks the whole machine part by part; this is
              the "zoom out" for the reader who wants the full picture. The
              hash opens the walkthrough ON this product's part (the hero
              maps `motors` to its singular beat id). */}
          <Link
            prefetch="intent"
            to={wit.chain ? `/#${wit.chain}` : '/'}
            className="what-home-link"
          >
            <Txt id="product-chrome.what_is_this_link_home" />
          </Link>
        </Chapter>
      );
    },
    /** What the board is published as: repos, license, latest commit. */
    openSource: (n, title) => (
      <Chapter
        number={n}
        label="Open for learning"
        title={title}
        titleId="product-chrome.ch_open_source_title"
        // The schematic viewer moved into the teardown chapter (2026-08-12,
        // maintainer: both viewers live under one repo-scope outline). wideMedia
        // keeps the 4-across card-row layout; noMedia stops the empty media
        // slot from rendering the placeholder glyph.
        wideMedia={!!schematicHandle}
        noMedia={!!schematicHandle}
      >
        <div className="open-source-cards">
          {content.bundle ? (
            content.bundle.components.map((c) => {
              const repo = PRODUCT_CONTENT[c.handle]?.repoUrl;
              if (!repo) return null;
              return (
                <a
                  key={c.handle}
                  href={repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="open-source-card open-source-card--github"
                >
                  <p className="open-source-card-label">{c.title}</p>
                  <Txt
                    id="product-chrome.os_card_repo_title"
                    as="p"
                    className="open-source-card-title"
                  />
                  <Txt
                    id="product-chrome.os_card_repo_sub_bundle"
                    as="p"
                    className="open-source-card-sub"
                  />
                </a>
              );
            })
          ) : (
            <>
              {/* Build-video bubble leads the row on products that have a
                  film, UNLESS the What-does-this-do chapter above already
                  plays it (no reason to sell the same video twice); those
                  pages fall through to the issues card like film-less ones. */}
              {content.video && !content.whatIsThis ? (
                <WatchCard
                  videoId={content.video.id}
                  title={content.video.title}
                  channel={content.video.channel}
                />
              ) : null}
              <a
                href={activeRepoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="open-source-card open-source-card--github"
              >
                <Txt
                  id="product-chrome.os_card_study_label"
                  as="p"
                  className="open-source-card-label"
                />
                <Txt
                  id="product-chrome.os_card_repo_title"
                  as="p"
                  className="open-source-card-title"
                />
                {/* CAD products (the frame) have no schematic/PCB. */}
                <Txt
                  id={
                    content.teardown?.frameViewer
                      ? 'product-chrome.os_card_repo_sub_cad'
                      : 'product-chrome.os_card_repo_sub'
                  }
                  as="p"
                  className="open-source-card-sub"
                />
                {/* The repository's own name, which can differ from the
                    shop name (the 20x20 FC is OpenFC-Lite-Mini). */}
                {repoName(activeRepoUrl) ? (
                  <p className="open-source-card-repo">
                    {say('product-chrome.os_card_repo_name', 'Design files: {repo}', {
                      repo: repoName(activeRepoUrl) ?? '',
                    })}
                  </p>
                ) : null}
              </a>
              {content.video && !content.whatIsThis ? null : (
                <a
                  href={`${activeRepoUrl}/issues`}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Watermark of the tool the design is iterated in: KiCad
                  // for boards, Onshape for the frame, same treatment as the
                  // GitHub and CERN cards.
                  className={`open-source-card ${
                    frameViewer
                      ? 'open-source-card--onshape'
                      : 'open-source-card--kicad'
                  }`}
                >
                  <Txt
                    id="product-chrome.os_card_issues_label"
                    as="p"
                    className="open-source-card-label"
                  />
                  <Txt
                    id="product-chrome.os_card_issues_title"
                    as="p"
                    className="open-source-card-title"
                  />
                  <Txt
                    id="product-chrome.os_card_issues_sub"
                    as="p"
                    className="open-source-card-sub"
                  />
                </a>
              )}
            </>
          )}
          {activeOshwaUid ? (
            // OSHWA-certified: lead with the open-hardware certification (links
            // the public cert page for this UID) and keep the CERN-OHL-S license
            // name on the sub-line - the certification attests the license, it
            // doesn't replace it.
            <a
              href={`https://certification.oshwa.org/${activeOshwaUid.toLowerCase()}.html`}
              target="_blank"
              rel="noopener noreferrer"
              className="open-source-card open-source-card--oshwa"
            >
              <OshwaMark
                uid={activeOshwaUid}
                title={`${copyText('product-chrome.oshwa_mark_title') ?? ''} · ${activeOshwaUid}`}
                className="open-source-card-oshwa-mark"
              />
              <Txt
                id="product-chrome.os_card_oshwa_sub"
                as="p"
                className="open-source-card-sub open-source-card-sub--oshwa"
              />
            </a>
          ) : (
            <a
              href="https://ohwr.org/cern_ohl_s_v2.txt"
              target="_blank"
              rel="noopener noreferrer"
              className="open-source-card open-source-card--cern"
            >
              <Txt
                id="product-chrome.os_card_license_label"
                as="p"
                className="open-source-card-label"
              />
              <Txt
                id="product-chrome.os_card_license_title"
                as="p"
                className="open-source-card-title"
              />
              <Txt
                id="product-chrome.os_card_license_sub"
                as="p"
                className="open-source-card-sub"
              />
            </a>
          )}
          {/* The row's 4th card hands the reader to the org's contributing
              guide. It replaced the changelog / latest-commit slot
              (2026-08-12): a recruiting card beats a sha for the reader who
              got this far. */}
          <a
            href={CONTRIBUTING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="open-source-card open-source-card--help"
          >
            <Txt
              id="product-chrome.os_card_help_label"
              as="p"
              className="open-source-card-label"
            />
            <Txt
              id="product-chrome.os_card_help_title"
              as="p"
              className="open-source-card-title"
            />
            <Txt
              id="product-chrome.os_card_help_sub"
              as="p"
              className="open-source-card-sub"
            />
          </a>
        </div>
        {/* One quiet mono link under the card row: the why behind the cards
            lives once, on /open-source, same idiom as the firmware chapter's
            "All firmware partners →". */}
        <p className="open-source-story-link">
          <Link prefetch="intent" to="/open-source">
            <Txt id="product-chrome.os_link_story" />
          </Link>
        </p>
      </Chapter>
    ),
    /** What it is made of: board art or exploded frame, plus the pin map. */
    teardown: (n, title) => (
        <Chapter
          number={n}
          label="Teardown"
          title={title}
          titleId={
            frameViewer
              ? 'product-chrome.ch_teardown_title_frame'
              : 'product-chrome.ch_teardown_title'
          }
          textReveal={frameViewer ? undefined : textIn}
          // Board explorer + schematic viewer share one repo-scope outline,
          // tied by the lead line to the GitHub-repo card above: the chapter
          // IS the repo's contents. The frame (backdrop, no schematic) opts out.
          repoScope={!frameViewer}
          wide={
            schematicHandle ? (
              // No key: keep the viewer mounted across tier switches so it
              // swaps between warmed manifests + sheets instantly instead of
              // remounting and refetching. `handles` preloads every tier.
              <SchematicViewer
                handle={schematicHandle}
                handles={schematicHandles}
                inspectUrl={
                  activeBoardArt?.schematicUrl ?? activeBoardArt?.inspectUrl
                }
                // The teardown's hovered part lights up on the schematic too;
                // the viewer pages to the sheet that carries the symbol.
                highlightRefs={hoveredRefs}
              />
            ) : undefined
          }
          backdrop={
            frameViewer ? (
              // No key on src: keep the canvas mounted across tier switches so
              // the viewer toggles between preloaded models instantly rather
              // than remounting and re-fetching the GLB. Wrapped so a WebGL
              // failure drops the (decorative) viewer instead of crashing the
              // whole product page.
              <SceneErrorBoundary fallback={null}>
                <ClientFrameViewer
                  src={frameViewer.src}
                  srcs={frameViewerSrcs}
                  inspectUrl={frameViewer.inspectUrl}
                />
              </SceneErrorBoundary>
            ) : undefined
          }
          media={
            !frameViewer && activeBoardArt ? (
              // Key by product HANDLE (not src): stays mounted across TIER swaps
              // so it swaps between warmed boards instantly (no remount/refetch),
              // but REMOUNTS on a product switch (FC↔ESC↔RX) so the one-shot
              // fly-in re-arms and plays for the new board. `srcs` prefetches the
              // tiers up front.
              <>
                <BoardArt
                  key={product.handle}
                  src={activeBoardArt.src}
                  srcs={boardArtSrcs}
                  inspectUrl={activeBoardArt.inspectUrl}
                  layerFns={activeBoardArt.layers}
                  handle={product.handle}
                  componentsSrc={activeBoardArt.src.replace(
                    /board\.svg$/,
                    'components.json',
                  )}
                  highlightRefs={hoveredRefs}
                  highlightUnion={hoveredUnion}
                  highlightGroups={hoveredGroups}
                  onFlying={setBoardFlying}
                  onHighlightVisible={setHighlightVisible}
                />
                {/* Part tour: which component is lit + how far through the set.
                    Swipe the board sideways (or tap a part) to step. Each tick is
                    tappable to jump straight to that part. */}
                {isMobile && orderedParts.length ? (
                  <div className="board-part-tour">
                    <p className="board-part-tour-head" aria-live="polite">
                      <Txt
                        id="product-chrome.teardown_tour_heading"
                        as="span"
                        className="board-deck-name"
                      />
                      <Txt
                        id="product-chrome.teardown_tour_hint"
                        as="span"
                        className="board-deck-hint"
                      />
                    </p>
                    {/* Real, labelled, thumb-sized chips split into a top-side and
                        a bottom-side row - not one long scroller. Tap one to
                        spotlight that part on the board; each row scrolls for the
                        rest. */}
                    {[
                      {
                        key: 'top',
                        label: copyText('product-chrome.teardown_side_top'),
                        aria: copyText('product-chrome.teardown_side_top_aria'),
                        parts: partRows.top,
                      },
                      {
                        key: 'bottom',
                        label: copyText('product-chrome.teardown_side_bottom'),
                        aria: copyText(
                          'product-chrome.teardown_side_bottom_aria',
                        ),
                        parts: partRows.bottom,
                      },
                    ]
                      .filter((row) => row.parts.length)
                      .map((row) => (
                        <div
                          key={row.key}
                          className="board-part-chips"
                          aria-label={row.aria}
                        >
                          <span className="board-part-chips-side">{row.label}</span>
                          {row.parts.map((p, i) => {
                            const lit = partLit(p);
                            return (
                              <button
                                type="button"
                                key={p.name + i}
                                className={`board-part-chip${lit ? ' is-active' : ''}`}
                                aria-pressed={lit}
                                // Tap toggles: a lit chip whose box is on the
                                // visible face clears; otherwise (not lit, or
                                // lit but hidden under another layer) it
                                // (re)asserts and BoardArt flips to the part.
                                // Set-only left the spotlight stuck on until
                                // another chip was tapped.
                                onClick={() => {
                                  if (lit && highlightVisible) {
                                    clearHover();
                                    return;
                                  }
                                  setHoveredRefs([...p.refs]);
                                  setHoveredUnion(p.union);
                                  setHoveredGroups(p.groups);
                                }}
                              >
                                {/* Just the model/short name on the chip (e.g.
                                    "RP2354A"), not the whole descriptive sentence
                                    - split off anything after a dash/middot. */}
                                {p.name.split(/\s+[\u2014\u2013·-]\s+/)[0]}
                                {p.cost && p.cost !== '×1' ? (
                                  <span className="board-part-chip-qty">{p.cost}</span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                  </div>
                ) : null}
              </>
            ) : undefined
          }
        >
          {groupedPins.top.length > 0 && groupedPins.bottom.length > 0 ? (
            <div
              className={`teardown-sides${boardFlying ? ' is-locked' : ''}${
                pinsSwapping ? ' is-swapping' : ''
              }`}
              onMouseLeave={noHover ? undefined : clearHover}
            >
              <section className="teardown-side">
                <ul className="teardown-pins">
                  {groupedPins.top.map(renderPin)}
                </ul>
              </section>
              <section className="teardown-side">
                <ul className="teardown-pins">
                  {[...groupedPins.bottom, ...groupedPins.other].map(renderPin)}
                </ul>
              </section>
            </div>
          ) : (
            <div
              className={`teardown-sides${boardFlying ? ' is-locked' : ''}${
                pinsSwapping ? ' is-swapping' : ''
              }`}
              onMouseLeave={noHover ? undefined : clearHover}
            >
              <section className="teardown-side">
                <ul className="teardown-pins">
                  {[
                    ...groupedPins.top,
                    ...groupedPins.bottom,
                    ...groupedPins.other,
                  ].map(renderPin)}
                </ul>
              </section>
            </div>
          )}
          {!frameViewer && activeBoardArt ? (
            <p className="teardown-render-note">
              {say('product-chrome.teardown_render_note', 'Render from the design files. Silkscreen may differ.')}
            </p>
          ) : null}
          {!frameViewer && activeBoardArt?.inspectUrl ? (
            <a
              className="board-art-inspect teardown-inspect"
              href={activeBoardArt.inspectUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {copyText('product-chrome.teardown_inspect_cta')}
            </a>
          ) : null}
        </Chapter>
    ),
    /** What it measures. */
    specs: (n, title) => {
      const multi = sheet.columns.length > 1;
      return (
        <Chapter
          id={SPECS_ID}
          number={n}
          label="Specs"
          title={title}
          titleId="product-chrome.ch_specs_title"
          noMedia
          centered
        >
          <div className="product-specs" ref={specsRef}>
            <ProductSilhouette
              boardSrc={activeBoardArt?.src ?? null}
              imageSrc={silhouetteImage ?? null}
              target={specsRef}
            />
            {/* Final values only, never a count-up: a buyer who reads or
                screenshots a spec must never see a wrong current or voltage. */}
            <table
              className={`spec-sheet${multi ? ' spec-sheet--multi' : ''}${
                sheet.columns.length > 2 ? ' spec-sheet--many' : ''
              }`}
            >
              {multi ? (
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">{say('product-chrome.compare_spec', 'Spec')}</span>
                    </th>
                    {sheet.columns.map((col) => (
                      <th
                        scope="col"
                        key={col}
                        className={col === activeTier ? 'is-active' : undefined}
                      >
                        <button
                          type="button"
                          className="spec-sheet-pick"
                          aria-pressed={col === activeTier}
                          onClick={() => pickTier(col)}
                        >
                          {variantDisplayName(product.handle, col)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {sheet.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {row.values.map((value, i) => {
                      const col = sheet.columns[i];
                      return (
                        <td
                          key={col || i}
                          className={multi && col === activeTier ? 'is-active' : undefined}
                          // The studio edits the mirrored value, so a tersed
                          // cell is shown but not editable in place.
                          {...(specsEditable && value && row.raw[i] === value && row.paths[i]
                            ? prodEdit(`${row.paths[i]}.1`)
                            : {})}
                        >
                          {value ?? ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {activeConnectors.length ? (
            <div className="spec-connectors">
              <h3 className="spec-connectors-title">
                {say('product-chrome.connectors_title', 'Plugs and pin order')}
              </h3>
              <dl className="spec-table">
                {activeConnectors.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {content.connectorsNote ? (
                <p className="spec-connectors-note" {...prodEdit('connectorsNote')}>
                  {content.connectorsNote}
                </p>
              ) : null}
            </div>
          ) : null}
        </Chapter>
      );
    },
    /** What ships. */
    inTheBox: (n, title) => (
        <Chapter
          id={IN_THE_BOX_ID}
          number={n}
          label="In the box"
          title={title}
          noMedia
          titleId={
            content.bundle
              ? 'product-chrome.ch_in_the_box_title_bundle'
              : 'product-chrome.ch_in_the_box_title'
          }
        >
          {content.bundle ? (
            <Txt
              id="product-chrome.in_the_box_bundle_body"
              as="p"
              className="chapter-body"
            />
          ) : null}
          {mergedBox.length > 0 ? (
            <ul className="in-the-box">
              {mergedBox.map((it, i) => {
                // Rows past the shared list came from the active variant's
                // own additions; tag each field with the leaf it renders.
                const boxBase =
                  i < content.inTheBox.length
                    ? `inTheBox.${i}`
                    : `variants.${activeTier}.inTheBox.${i - content.inTheBox.length}`;
                return (
                  <li key={`${it.qty ?? ''}${it.item}`}>
                    {it.qty ? (
                      <span
                        className="in-the-box-qty"
                        {...prodEdit(`${boxBase}.qty`)}
                      >
                        {it.qty}
                      </span>
                    ) : null}
                    <span
                      className="in-the-box-item"
                      {...prodEdit(`${boxBase}.item`)}
                    >
                      {it.item}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {content.bundle ? (
            <div className="bundle-components">
              {content.bundle.components.map((c, ci) => (
                <Link
                  key={c.handle}
                  to={`/products/${c.handle}`}
                  prefetch="intent"
                  className="bundle-component-card"
                >
                  <p
                    className="bundle-component-title"
                    {...prodEdit(`bundle.components.${ci}.title`)}
                  >
                    {c.title}
                  </p>
                  <p
                    className="bundle-component-blurb"
                    {...prodEdit(`bundle.components.${ci}.blurb`)}
                  >
                    {c.blurb}
                  </p>
                  <p className="bundle-component-firmware">
                    {copyText('product-chrome.bundle_component_firmware_label')}{' '}
                    <span {...prodEdit(`bundle.components.${ci}.firmware`)}>
                      {c.firmware}
                    </span>
                  </p>
                  <Txt
                    id="product-chrome.bundle_component_more"
                    as="span"
                    className="bundle-component-more"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </div>
          ) : null}
          {isBoard ? <ProvenanceCard /> : null}
        </Chapter>
    ),
    /** The files themselves. */
    downloads: (n, title) => (
        <Chapter
          number={n}
          label="Downloads"
          title={title}
          noMedia
          titleId="product-chrome.ch_downloads_title"
        >
          <Txt
            id="product-chrome.downloads_intro"
            as="p"
            className="chapter-body"
          />
          <DownloadsGrid
            downloads={downloads}
            editBase={`${product.handle}.downloads`}
            editableCount={content.downloads.length}
          />
        </Chapter>
    ),
    /** The open firmware the board runs, and how to support its devs. */
    firmware: (n, title) => (
        <Chapter
          number={n}
          label="Firmware"
          title={title}
          titleId="product-chrome.ch_firmware_title"
          media={
            content.firmware.logo ? (
              /* Not loading="lazy": same reason as the contributor avatars,
                 a lazy image inside a content-visibility: auto chapter is
                 treated as far offscreen and never fetched. */
              <img
                className={
                  content.firmware.logoDark
                    ? 'firmware-logo firmware-logo--tile'
                    : 'firmware-logo'
                }
                src={content.firmware.logo}
                alt={`${content.firmware.project} ${copyText('product-chrome.firmware_logo_alt_suffix') ?? ''}`}
                decoding="async"
              />
            ) : undefined
          }
        >
          <div className="firmware-freedom">
            <p className="firmware-freedom-title">
              {say('product-chrome.firmware_freedom_title', 'Flash what you want')}
            </p>
            <p>
              {say(
                'product-chrome.firmware_freedom_body',
                'Ships with {project}. No activation, no locked bootloader. Reflashing keeps the 2-year warranty.',
                {project: content.firmware.project},
              )}{' '}
              <Link prefetch="intent" to="/warranty">
                {say('product-chrome.firmware_freedom_link', 'Warranty')}
              </Link>
            </p>
          </div>
          <FirmwareSupport
            firmwareProject={content.firmware.project}
            firmwareUrl={content.firmware.projectUrl}
          />
        </Chapter>
    ),
    /**
     * Who built it. GitHub accounts with commits on the product's repos,
     * streamed in deferred. The grid always closes with a "+ you" tile pointing
     * at Discord (talk before touching files); when GitHub rate-limits the
     * fetch the chapter still renders with just that invitation.
     */
    contributors: (n, title) => (
        <Chapter
          number={n}
          label="Contributors"
          title={title}
          titleId="product-chrome.ch_contributors_title"
          noMedia
        >
          {/* No prose above the grid; the how-and-why lives once, on the
              org contributing guide. The button sits to the grid's right - the
              row of people ends in the door you walk through to join them. */}
          <div className="contributors-row">
            <Suspense fallback={<ContributorGridSkeleton />}>
              <Await
                resolve={contributors}
                errorElement={<ContributorGrid contributors={[]} />}
              >
                {(list) => (
                  <ContributorGrid
                    contributors={orderByCredits(list ?? [], content.credits)}
                    lead={content.credits?.[0]}
                  />
                )}
              </Await>
            </Suspense>
            <a
              href={CONTRIBUTING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="contributors-cta-btn"
            >
              <Txt id="product-chrome.contributors_link_contribute" />
            </a>
          </div>
        </Chapter>
    ),
    /**
     * Published product ratings from the catalog, own markup (no widget).
     */
    reviews: (n, title) => {
      // `present` already ruled this out, but the aggregate is read half a
      // dozen times below and the compiler wants the narrowing spelled out.
      if (!reviewAggregate) return null;
      return (
        <Chapter
          id="reviews"
          number={n}
          label="Reviews"
          title={title}
          titleId="product-chrome.ch_reviews_title"
          noMedia
        >
          {/* The aggregate is catalog data, so the framing sentence marks its
              slots with `{average}`, `{count}` and `{ratings}` and stays one
              editable string. */}
          <p className="chapter-body" {...editAttrs('product-chrome.reviews_intro')}>
            {(copyText('product-chrome.reviews_intro') ?? '')
              .replace('{average}', reviewAggregate.value.toFixed(1))
              .replace('{count}', String(reviewAggregate.count))
              .replace(
                '{ratings}',
                copyText(
                  reviewAggregate.count === 1
                    ? 'product-chrome.reviews_rating_one'
                    : 'product-chrome.reviews_rating_many',
                ) ?? '',
              )}
          </p>
          <ReviewList aggregate={reviewAggregate} shopUrl={product.shopUrl} />
        </Chapter>
      );
    },
    /**
     * The generic type. Everything it says comes from the copy store, so the maintainer
     * can add as many as he likes without a code change.
     */
    prose: (n, title, id) => {
      const titleId = proseKey(id, 'title');
      // A missing title must leave no heading at all. `<Txt>` renders nothing
      // for an absent key, but the element is still truthy, so Chapter would
      // draw an empty <h2>.
      const heading =
        title ??
        (copy(titleId) === undefined ? null : <Txt id={titleId} as="span" />);
      return (
        <Chapter number={n} label="Free text" title={heading} noMedia>
          <Txt id={proseKey(id, 'body')} as="p" className="chapter-body" />
        </Chapter>
      );
    },
  };

  return (
    <div className="product-page">
      <script
        type="application/ld+json"
         
        dangerouslySetInnerHTML={{__html: JSON.stringify(productJsonLd)}}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            buildBreadcrumbJsonLd([
              {name: 'OpenDrone', path: '/'},
              {name: 'Products', path: '/products'},
              {name: product.title, path: `/products/${product.handle}`},
            ]),
          ),
        }}
      />
      {/* === HERO: gallery left, copy + sticky buy module right === */}
      <section className="product-hero">
        <div className="product-hero-gallery-col">
          <div
            className={`product-hero-media${
              galleryImages.length && imagesAreRenders(product.handle) ? ' is-render' : ''
            }`}
          >
            {galleryImages.length && imagesAreRenders(product.handle) ? (
              <span className="render-chip">{say('product-chrome.render_chip', 'Render')}</span>
            ) : null}
            {activeVariant?.imageNote && galleryImages.length ? (
              <span className="product-image-note">{activeVariant.imageNote}</span>
            ) : null}
            <ProductGallery
              images={galleryImages}
              activeImageId={selectedVariant?.image?.id ?? null}
              emptyFallback={
                <ProductGhostTile type={product.productType} title={product.title} />
              }
            />
          </div>
        </div>

        <div className="product-hero-copy">
          <h1 className="product-hero-name">{title}</h1>
          {subtitle ? (
            <p
              className="product-hero-sub"
              {...prodEdit(activeVariant?.subtitle ? `variants.${activeTier}.subtitle` : 'subtitle')}
            >
              {subtitle}
            </p>
          ) : null}
          <div className="buy-rail">
            {railLadder}
            {railBuyModule}
            <div ref={setRailSentinel} className="buy-rail-sentinel" aria-hidden="true" />
          </div>
          {activeOshwaUid || hasPublicSource ? (
            <ul
              className="trust-chips"
              aria-label={copyText('product-chrome.trust_chips_aria')}
            >
              {activeOshwaUid ? (
                <li>
                  <a
                    href={`https://certification.oshwa.org/${activeOshwaUid.toLowerCase()}.html`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="trust-chip trust-chip-oshwa trust-chip-link"
                    title={`${copyText('product-chrome.oshwa_mark_title') ?? ''} · ${activeOshwaUid}`}
                  >
                    <img
                      src="/logos/oshwa.svg"
                      alt=""
                      aria-hidden="true"
                      className="trust-chip-oshwa-mark"
                    />
                    <span className="trust-chip-oshwa-word">OSHWA</span>
                    <span className="trust-chip-oshwa-uid">{activeOshwaUid}</span>
                  </a>
                </li>
              ) : null}
              {hasPublicSource ? (
                <li>
                  <a
                    href={activeRepoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="trust-chip trust-chip-link"
                    title={repoName(activeRepoUrl) ?? undefined}
                  >
                    {say('product-chrome.trust_chip_source', 'GitHub')}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : null}

          {/* The compact bar, portaled to <body> so the fixed overlay escapes
              the hero's stacking context. Coming soon: the chips alone. */}
          {railPinned && !footerInView && typeof document !== 'undefined'
            ? createPortal(
                <div
                  className={`buy-rail is-pinned${railMobile ? ' is-mobile' : ''}${soon ? ' is-ladderonly' : ''}${
                    asideType !== 'closed' ? ' is-suppressed' : ''
                  }`}
                  style={railBox && !railMobile ? {right: railBox.right} : undefined}
                >
                  {railLadderPinned}
                  {soon ? null : railBuyModule}
                </div>,
                document.body,
              )
            : null}
        </div>
      </section>

      {/* === Chapters, in the order `content/chapters.json` puts them === */}
      {buyingOrder(resolveChapters(product.handle, present)).map((c) => (
        <Fragment key={c.id}>
          {chapterNodes[c.type]?.(c.number, c.title, c.id)}
        </Fragment>
      ))}

      <RelatedProducts recommendations={recommendations} />

      {rootData?.company ? (
        <details className="product-safety" id="product-safety">
          <summary><Txt id="product-chrome.gpsr_heading" /></summary>
          <GpsrBlock
            compact
            company={rootData.company}
            productTitle={
              catalogAxisValue && isInternalSku(product.handle, catalogAxisValue)
                ? `${product.title} ${variantDisplayName(product.handle, catalogAxisValue)}`
                : product.title
            }
            sku={shownSku}
            kind={safetyKind(product.handle)}
            country={rootData.visitorCountry ?? null}
            registrations={registrationNumbers(rootData.visitorCountry ?? null)}
          />
        </details>
      ) : null}
    </div>
  );
}
