import {Suspense, useEffect, useRef, useState} from 'react';
import {Await, useAsyncValue, useLocation} from 'react-router';
import {NavLink} from '~/components/nav';
import {AnimatePresence} from 'motion/react';
import {
  type CartViewPayload,
  useAnalytics,
  useOptimisticCart,
} from '@shopify/hydrogen';
import type {HeaderQuery, CartApiQueryFragment} from 'storefrontapi.generated';
import {useAside} from '~/components/Aside';
import {LangToggle} from '~/components/LangToggle';
import {ThemeToggle} from '~/components/ThemeToggle';
import {SiteWordmark} from '~/components/SiteWordmark';
import {IncutecWordmark} from '~/components/IncutecWordmark';
import {Pod} from '~/components/Pod';
import {SearchForm} from '~/components/SearchForm';
import {
  ProductPods,
  type ProductPodItem,
  type PodCompanionOption,
} from '~/components/ProductPods';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {INCUTEC_HINT_SEEN_KEY} from '~/lib/incutec-hint';
import {
  useProductStatusResolver,
  useRoadmapStatusResolver,
} from '~/lib/coming-soon';
import {
  isComingSoon,
  isConceptFor,
  isPurchasableStatus,
  PRODUCT_CONTENT,
} from '~/lib/product-content';
import {stackDiscountedPrice} from '~/lib/stack-discount';

/** Retire the hero "Who's incutec?" hint: persist the dismissal and pull the
 *  class so it can't flash on a same-session SPA return to the homepage. */
function dismissIncutecHint() {
  try {
    localStorage.setItem(INCUTEC_HINT_SEEN_KEY, '1');
  } catch {
    /* storage blocked (private mode) — the nudge just isn't persisted */
  }
  document.documentElement.classList.remove('hero-incutec-hint');
}

/** Thin shape of a product as read by HEADER_PRODUCTS_QUERY. */
export type HeaderFamilyVariant = {
  id: string;
  title: string;
  availableForSale?: boolean;
  image?: {url: string; altText?: string | null} | null;
  price?: {amount: string; currencyCode: string} | null;
  selectedOptions?: Array<{name: string; value: string}>;
};

export type HeaderFamilyProduct = {
  id: string;
  handle: string;
  title: string;
  productType?: string | null;
  featuredImage?: {url: string; altText?: string | null} | null;
  priceRange?: {
    minVariantPrice?: {amount: string; currencyCode: string} | null;
  } | null;
  variants?: {nodes: HeaderFamilyVariant[]} | null;
};

interface HeaderProps {
  header: HeaderQuery;
  cart: Promise<CartApiQueryFragment | null>;
  isLoggedIn: Promise<boolean>;
  publicStoreDomain: string;
  familyProducts?: Promise<HeaderFamilyProduct[]>;
}

type Viewport = 'desktop' | 'mobile';

// The header's own words live in `content/copy/chrome.json` and are rendered
// through <Txt>. Three sets of strings deliberately do NOT: the Shopify menu
// titles (edited in Shopify admin, including FALLBACK_HEADER_MENU which mirrors
// it), anything derived from product data, and the family labels below — those
// double as dropdown state keys and as the short names on the buy buttons, so
// they are structure, not copy.
//
// Category links jump straight to the current PDP for each family.
// Accessories no longer get a dedicated link here — they live (with
// everything else) on the aggregated All Products page, reachable via the
// "All Products" CTA on the right, filterable by category there.
// Each family chip links to its representative PDP and, on hover, drops a Pod
// listing every SKU of that Shopify `productType`.
const CATEGORY_LINKS: Array<{label: string; to: string; type: string}> = [
  {label: 'FC', to: '/products/openfc-lite', type: 'Flight Controller'},
  {label: 'ESC', to: '/products/openesc', type: 'ESC'},
  {label: 'RX', to: '/products/openrx', type: 'Receiver'},
  {label: 'Frame', to: '/products/openframe', type: 'Frame'},
];

/** Fuller family names for the mobile drawer (the desktop FamilyNav chips use
 *  the terse FC/ESC/… labels; the drawer has room to spell them out). */
const MOBILE_FAMILY_LABEL: Record<string, string> = {
  'Flight Controller': 'Flight Controllers',
  ESC: 'ESCs',
  Receiver: 'Receivers',
  Frame: 'Frames',
};

/** Stack companions per family: each pod row offers "+X" buttons for these
 *  partner products, size-matched by the Model option. N-to-N ready: every
 *  entry in a family's list becomes its own button in the buy cell (they
 *  stack vertically), so a second compatible ESC — or an OpenFC Pro on the
 *  ESC side — is one more `{handle, short}` here. Keep `short` unique per
 *  list ("ESC 30×30", "FC PRO") once a family has two partners, since it's
 *  the visible label. Only the pairing lives here; the discount claim (the
 *  automatic BXGY's percent and which ONE board of the pair it is off,
 *  today the OpenESC, never both) derives per row from that product's
 *  `stack` config in product-content.ts, so removing `discountPct` or
 *  `discountedHandle` there silences the header's claim too. */
const STACK_COMPANIONS: Record<string, Array<{handle: string; short: string}>> = {
  'Flight Controller': [{handle: 'openesc', short: 'ESC'}],
  ESC: [{handle: 'openfc-lite', short: 'FC'}],
};

/** Short family label ("FC", "ESC") for a productType — names the buy
 *  buttons so "FC only" vs "FC + ESC stack" is unambiguous. */
function selfShortFor(type: string): string {
  return CATEGORY_LINKS.find((c) => c.type === type)?.label ?? 'board';
}

/** Minimal ProductVariant-ish shape so useOptimisticCart can render the
 *  pending line immediately instead of console-erroring and waiting for the
 *  server cart. Cast at the use site — the header only has the thin query. */
function optimisticVariant(
  v: HeaderFamilyVariant,
  product: {title: string; handle: string},
) {
  return {
    id: v.id,
    title: v.title,
    availableForSale: v.availableForSale ?? true,
    price: v.price,
    image: v.image ?? null,
    product,
    selectedOptions: v.selectedOptions ?? [],
  } as unknown as NonNullable<
    import('@shopify/hydrogen').OptimisticCartLineInput['selectedVariant']
  >;
}

export function Header({
  header,
  isLoggedIn,
  cart,
  publicStoreDomain,
  familyProducts,
}: HeaderProps) {
  const {menu} = header;
  // Dynamic-Island logo slot. On the hero ("/") the OpenDrone wordmark already
  // lives bottom-left in the 3D scene, so the bar instead credits the parent
  // company — the Incutec mark linking to incutec.eu (OpenDrone is an Incutec
  // product brand). On every other route the slot is the OpenDrone wordmark
  // home link. The slot is a fixed width so the nav chips never shift between
  // routes; view-transition-name animates the swap across navigations.
  const {pathname} = useLocation();
  const isHero = pathname === '/';
  return (
    <header className="site-header">
      <div className="site-header-main">
        {/* Left: brand slot — OpenDrone home link, or Incutec credit on the hero.
            On the hero the mark links to the in-site Incutec company page, and a
            "Who's incutec?" hint drops out from under it a beat after the header
            lands (gated on `html.hero-incutec-hint`, set by the homepage). */}
        {isHero ? (
          <span className="site-header-incutec-slot">
            <NavLink
              prefetch="intent"
              to="/incutec"
              className="site-header-logo site-header-logo--incutec"
              aria-label={
                copyText('chrome.incutec_logo_aria') ??
                'Incutec, the company behind OpenDrone'
              }
              style={{viewTransitionName: 'site-logo'}}
              onClick={dismissIncutecHint}
            >
              <IncutecWordmark className="site-header-incutec" />
            </NavLink>
            <NavLink
              prefetch="intent"
              to="/incutec"
              className="incutec-hint"
              tabIndex={-1}
              aria-hidden="true"
              onClick={dismissIncutecHint}
            >
              <Txt id="chrome.incutec_hint" />
            </NavLink>
          </span>
        ) : (
          <NavLink
            prefetch="viewport"
            to="/"
            end
            className="site-header-logo"
            aria-label="OpenDrone"
            style={{viewTransitionName: 'site-logo'}}
          >
            <SiteWordmark className="site-header-wordmark" />
          </NavLink>
        )}

        {/* Center: primary nav + gold category links on the same row */}
        <HeaderMenu
          menu={menu}
          viewport="desktop"
          primaryDomainUrl={header.shop.primaryDomain.url}
          publicStoreDomain={publicStoreDomain}
        />
        {/* Category families in segmented bubbles: FC and ESC share one
            (their rows sell the stack), while RX and Frame are standalone
            families so each gets its own bubble; All Products follows in its
            own accented bubble as the route into the full catalogue. No
            dividers — the bubbles do the grouping. */}
        <FamilyNav familyProducts={familyProducts} />

        {/* Right: actions */}
        <HeaderCtas isLoggedIn={isLoggedIn} cart={cart} />
      </div>
    </header>
  );
}

/**
 * The gold family chips (FC/ESC/Stack/RX/Frame) — segmented bubbles that, on
 * hover/focus, drop a Pod listing every SKU of that productType (thumbnail +
 * title + price). The chip itself still links to the family's PDP. Deferred
 * product data is resolved once on first hover so the chips render instantly.
 * Desktop-only (the nav is hidden below 900px). Same Pod material + popOpen
 * motion as the hero showcase.
 */
function FamilyNav({
  familyProducts,
}: {
  familyProducts?: Promise<HeaderFamilyProduct[]>;
}) {
  const [products, setProducts] = useState<HeaderFamilyProduct[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // True for the tick after Escape restores focus to a chip (see onFocus).
  const escFocus = useRef(false);
  const location = useLocation();
  // Cart drawer opener for the Stack chip's add buttons (named to avoid the
  // `open` dropdown-state collision above).
  const {open: openCartAside} = useAside();
  // Global coming-soon flag; per-product overrides resolve in isComingSoon()
  // below so unlaunched SKUs list without price or buy cell.
  const productStatus = useProductStatusResolver();
  const roadmapStatus = useRoadmapStatusResolver();

  // Close the hover dropdown on any navigation — otherwise clicking a SKU drops
  // you on the page with the menu still stuck open (mouseleave never fires when
  // the pointer is over the navigating link).
  useEffect(() => {
    clearTimeout(closeTimer.current);
    setOpen(null);
  }, [location.pathname, location.search]);

  function ensureProducts() {
    if (products || !familyProducts) return;
    familyProducts.then((p) => setProducts(p)).catch(() => setProducts([]));
  }
  function openFamily(label: string) {
    ensureProducts();
    clearTimeout(closeTimer.current);
    setOpen(label);
  }
  function scheduleClose() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(null), 140);
  }

  // Backstop for the hover dropdown: onMouseLeave/onBlur are not reliable — a
  // fast pointer move, a scroll, or the pod re-rendering under the cursor can
  // swallow the leave event, leaving the menu stuck open (no longer hovered).
  // While something is open, watch the pointer and scroll globally: any pointer
  // that isn't over a `.header-cat` (the chip OR its pod, which lives inside it)
  // schedules the close; scrolling closes immediately.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.header-cat')) scheduleClose();
    };
    const onScroll = () => {
      clearTimeout(closeTimer.current);
      setOpen(null);
    };
    document.addEventListener('pointermove', onPointer);
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => {
      document.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [open]);

  // "also add an X" cascade for an FC/ESC row: each companion product's
  // variant at the same Model size, with both cart lines prebuilt.
  function companionsFor(
    type: string,
    v: HeaderFamilyVariant,
    rowProduct: {title: string; handle: string},
  ): PodCompanionOption[] | undefined {
    const cfg = STACK_COMPANIONS[type];
    if (!cfg) return undefined;
    const size = v.selectedOptions?.find(
      (o) => o.name.trim().toLowerCase() === 'model',
    )?.value;
    if (!size) return undefined;
    // The discount claim derives from the row product's StackConfig: the
    // pct is off the discountedHandle board ONLY, never the pair. Both
    // fields absent or partial -> no pct, no badge, full prices.
    const stack = PRODUCT_CONTENT[rowProduct.handle]?.stack;
    const pct =
      stack?.discountPct && stack.discountedHandle
        ? stack.discountPct
        : undefined;
    const options = cfg.flatMap(({handle: h, short}) => {
      // Unlaunched partners can't cascade into a stack add.
      if (!isPurchasableStatus(productStatus(h))) return [];
      const partner = (products ?? []).find((p) => p.handle === h);
      const pv = partner?.variants?.nodes?.find((pvv) =>
        pvv.selectedOptions?.some(
          (o) =>
            o.name.trim().toLowerCase() === 'model' &&
            o.value.trim().toLowerCase() === size.trim().toLowerCase(),
        ),
      );
      if (!partner || !pv) return [];
      // Partner discounted (FC row adding the ESC): show the ESC's derived
      // checkout price, full price alongside for the tooltip. Self
      // discounted (ESC row adding the FC): the FC price stays full and
      // the badge names the ESC instead.
      const partnerDiscounted = Boolean(pct) && stack?.discountedHandle === h;
      const selfDiscounted =
        Boolean(pct) && stack?.discountedHandle === rowProduct.handle;
      return [
        {
          key: h,
          title: `${partner.title} · ${size}`,
          short,
          price:
            pv.price && partnerDiscounted && pct
              ? stackDiscountedPrice(pv.price, pct)
              : (pv.price ?? null),
          fullPrice: partnerDiscounted ? (pv.price ?? null) : null,
          pct,
          discountedShort: partnerDiscounted
            ? short
            : selfDiscounted
              ? selfShortFor(type)
              : undefined,
          available: Boolean(pv.availableForSale && v.availableForSale),
          imageUrl: pv.image?.url ?? partner.featuredImage?.url ?? null,
          lines: [
            {
              merchandiseId: v.id,
              quantity: 1,
              selectedVariant: optimisticVariant(v, rowProduct),
            },
            {
              merchandiseId: pv.id,
              quantity: 1,
              selectedVariant: optimisticVariant(pv, {
                title: partner.title,
                handle: partner.handle,
              }),
            },
          ],
        },
      ];
    });
    return options.length ? options : undefined;
  }

  function itemsFor(type: string): ProductPodItem[] {
    return (products ?? [])
      .filter((p) => (p.productType || '') === type)
      // Planned / in-progress products have no settled tiers, images or
      // names to preview: the chip itself links to their concept plate and
      // the pod stays closed (docs/product-status.md).
      .filter((p) => !isConceptFor(p.handle, roadmapStatus(p.handle)))
      .flatMap((p) => {
        // Coming-soon products list (the dropdown is navigation) but carry
        // no price and no buy cell — the PDP hosts the notify signup.
        const soon = !isPurchasableStatus(productStatus(p.handle));
        // Real, distinguishable variants (drop the single "Default Title").
        const variants = (p.variants?.nodes ?? []).filter(
          (v) => v.title && v.title !== 'Default Title',
        );
        // Single-variant product → one row for the product itself.
        if (variants.length <= 1) {
          const only = p.variants?.nodes?.[0];
          return [
            {
              key: p.handle,
              to: `/products/${p.handle}`,
              title: p.title,
              subtitle: p.productType ?? undefined,
              imageUrl: p.featuredImage?.url ?? null,
              imageAlt: p.featuredImage?.altText ?? null,
              price: soon ? null : (p.priceRange?.minVariantPrice ?? null),
              soon,
              buy: soon
                ? undefined
                : only
                ? {
                    lines: [
                      {
                        merchandiseId: only.id,
                        quantity: 1,
                        selectedVariant: optimisticVariant(only, {
                          title: p.title,
                          handle: p.handle,
                        }),
                      },
                    ],
                    available: Boolean(only.availableForSale),
                    flyImage:
                      only.image?.url ?? p.featuredImage?.url ?? null,
                    selfShort: selfShortFor(type),
                  }
                : undefined,
            },
          ];
        }
        // Multi-variant → a row per SKU, deep-linking the variant on the PDP.
        return variants.map((v) => {
          const params = new URLSearchParams();
          (v.selectedOptions ?? []).forEach((o) => params.set(o.name, o.value));
          const qs = params.toString();
          return {
            key: v.id,
            to: `/products/${p.handle}${qs ? `?${qs}` : ''}`,
            // SKU/variant name is the headline (gold); the family line is the
            // dim context beneath it.
            title: v.title,
            subtitle: p.title,
            imageUrl: v.image?.url ?? p.featuredImage?.url ?? null,
            imageAlt: v.image?.altText ?? p.featuredImage?.altText ?? null,
            price: soon ? null : (v.price ?? p.priceRange?.minVariantPrice ?? null),
            soon,
            buy: soon
              ? undefined
              : {
                  lines: [
                    {
                      merchandiseId: v.id,
                      quantity: 1,
                      selectedVariant: optimisticVariant(v, {
                        title: p.title,
                        handle: p.handle,
                      }),
                    },
                  ],
                  available: Boolean(v.availableForSale),
                  flyImage: v.image?.url ?? p.featuredImage?.url ?? null,
                  selfShort: selfShortFor(type),
                  companions: companionsFor(type, v, {
                    title: p.title,
                    handle: p.handle,
                  }),
                },
          };
        });
      });
  }

  function chip(cat: (typeof CATEGORY_LINKS)[number]) {
    const items = itemsFor(cat.type);
    return (
      // The wrapper itself isn't interactive — the chip link and pod rows
      // inside are. onKeyDown here is a container-level Escape listener so
      // Escape works from anywhere within the open pod.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        className="header-cat"
        key={cat.label}
        onMouseEnter={() => openFamily(cat.label)}
        onMouseLeave={scheduleClose}
        onFocus={() => {
          // Swallow the focus event caused by Escape's own focus restore —
          // otherwise the menu instantly reopens.
          if (escFocus.current) return;
          openFamily(cat.label);
        }}
        onBlur={scheduleClose}
        onKeyDown={(e) => {
          // Escape closes the pod and hands focus back to the chip, so a
          // keyboard user isn't stranded in a closed popup.
          if (e.key === 'Escape' && open === cat.label) {
            e.stopPropagation();
            clearTimeout(closeTimer.current);
            setOpen(null);
            escFocus.current = true;
            e.currentTarget.querySelector('a')?.focus();
            setTimeout(() => {
              escFocus.current = false;
            }, 0);
          }
        }}
      >
        <NavLink
          prefetch="viewport"
          to={cat.to}
          aria-expanded={open === cat.label}
        >
          {cat.label}
        </NavLink>
        <div className="header-cat-pod-wrap">
          <AnimatePresence>
            {/* role=group, not menu: the pod is a list of links/buttons in
                natural tab order, not an arrow-key ARIA menu widget. */}
            {open === cat.label && items.length > 0 ? (
              <Pod
                animate
                origin="top center"
                className="header-cat-pod"
                role="group"
                ariaLabel={`${cat.label} products`}
              >
                <ProductPods
                  items={items}
                  layout="row"
                  onAdd={() => {
                    setOpen(null);
                    openCartAside('cart');
                  }}
                />
              </Pod>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  return (
    <nav className="site-header-categories" aria-label="Product categories">
      {/* FC and ESC share one bubble (a stack is bought from their rows);
          RX and Frame are standalone families with their own bubbles. */}
      <span className="site-header-cat-group">
        {CATEGORY_LINKS.slice(0, 2).map(chip)}
      </span>
      {CATEGORY_LINKS.slice(2).map((cat) => (
        <span className="site-header-cat-group" key={cat.label}>
          {chip(cat)}
        </span>
      ))}
      <NavLink
        prefetch="viewport"
        to="/collections/all"
        className="site-header-cat-all"
      >
        <Txt id="chrome.nav_all_products" />
      </NavLink>
    </nav>
  );
}

export function HeaderMenu({
  menu,
  primaryDomainUrl,
  viewport,
  publicStoreDomain,
}: {
  menu: HeaderProps['header']['menu'];
  primaryDomainUrl: HeaderProps['header']['shop']['primaryDomain']['url'];
  viewport: Viewport;
  publicStoreDomain: HeaderProps['publicStoreDomain'];
}) {
  const {close} = useAside();
  const isMobile = viewport === 'mobile';

  return (
    <nav
      className={
        isMobile
          ? 'site-mobile-nav flex flex-col gap-1 px-1'
          : 'hidden md:flex items-center gap-8 ml-10'
      }
      role="navigation"
    >
      {/* Mobile drawer only: surface Search + the product families + Home up
          top. The desktop header carries these in its own bar / FamilyNav,
          which is hidden on phones — without this the drawer was four links in
          a sea of empty panel and the whole product taxonomy vanished. */}
      {isMobile && (
        <>
          <SearchForm
            action="/collections/all"
            className="site-mobile-nav-search"
            onSubmit={() => close()}
          >
            {({inputRef}) => (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  ref={inputRef}
                  type="search"
                  name="q"
                  placeholder={
                    copyText('chrome.search_placeholder') ?? 'Search products'
                  }
                  aria-label={
                    copyText('chrome.search_placeholder') ?? 'Search products'
                  }
                  enterKeyHint="search"
                />
              </>
            )}
          </SearchForm>
          <Txt
            id="chrome.heading_shop"
            as="p"
            className="site-mobile-nav-label"
          />
          {CATEGORY_LINKS.map((c) => (
            <NavLink
              key={c.to}
              onClick={close}
              prefetch="viewport"
              to={c.to}
              className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              {MOBILE_FAMILY_LABEL[c.type] ?? c.label}
            </NavLink>
          ))}
          <NavLink
            onClick={close}
            prefetch="viewport"
            to="/collections/all"
            className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <Txt id="chrome.nav_all_products_mobile" />
          </NavLink>
          <Txt
            id="chrome.heading_more"
            as="p"
            className="site-mobile-nav-label"
          />
          <NavLink
            end
            onClick={close}
            prefetch="viewport"
            to="/"
            className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <Txt id="chrome.nav_home" />
          </NavLink>
        </>
      )}
      {(menu || FALLBACK_HEADER_MENU).items.map((item) => {
        if (!item.url) return null;
        let url =
          item.url.includes('myshopify.com') ||
          item.url.includes(publicStoreDomain) ||
          item.url.includes(primaryDomainUrl)
            ? new URL(item.url).pathname
            : item.url;
        // The Storefront API returns menu URLs locale-prefixed
        // ("/nl/collections/all") when the query runs @inContext with a
        // non-default language. Only legal pages exist under locale
        // prefixes in this app, so strip the prefix: it makes the skip
        // rules below match in every locale and un-breaks the links
        // themselves (a prefixed "/nl/collections/all" is a 404 here).
        url = url.replace(/^\/(en|nl|fr)(?=\/|$)/, '') || '/';
        // Rewrite Shopify Pages handles to our local routes when one
        // exists. Shopify's main menu defaults Contact to /pages/contact
        // even though we own a local /contact route with the support
        // widget; without this rewrite the menu link lands on an empty
        // Shopify Page.
        url = LOCAL_PAGE_REWRITES[url] ?? url;
        // Drop any menu item that resolves to "/" — the wordmark logo
        // on the left already links there, so a separate "Home" entry
        // is duplicated chrome. This skips it in code so we don't have
        // to keep the Shopify admin menu in sync.
        if (url === '/' || url === '') return null;
        // Catalog + Contact render in the right-side CTA group; skip
        // them here to avoid duplicate links in the center menu.
        if (!isMobile && (url === '/collections/all' || url === '/support')) return null;
        const className = isMobile
          ? 'text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors'
          : 'font-mono text-[12px] uppercase tracking-[0.15em] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)]';

        if (!url.startsWith('/')) {
          return (
            <a
              className={className}
              href={url}
              key={item.id}
              onClick={close}
              rel="noopener noreferrer"
              target="_blank"
            >
              {item.title}
            </a>
          );
        }

        return (
          <NavLink
            end
            key={item.id}
            onClick={close}
            prefetch="viewport"
            to={url}
            className={({isActive}) =>
              `${isMobile ? 'text-sm tracking-wider' : 'text-[12px] tracking-[0.15em]'} font-mono uppercase transition-colors ${
                isActive
                  ? 'text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`
            }
          >
            {item.title}
          </NavLink>
        );
      })}
      {/* Mobile aside only: a Newsletter link in the slide-out menu. On
          desktop Newsletter lives in the right-side CTA group (left of
          Catalog), so it's omitted here to avoid duplicating it. Skipped if
          the Shopify menu already links to /newsletter. */}
      {isMobile &&
      !(menu || FALLBACK_HEADER_MENU).items.some((it) =>
        it.url?.includes('/newsletter'),
      ) ? (
        <NavLink
          end
          onClick={close}
          prefetch="viewport"
          to="/newsletter"
          className={({isActive}) =>
            `${isMobile ? 'text-sm tracking-wider' : 'text-[12px] tracking-[0.15em]'} font-mono uppercase transition-colors ${
              isActive
                ? 'text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`
          }
        >
          <Txt id="chrome.nav_newsletter" />
        </NavLink>
      ) : null}
      {isMobile ? (
        <>
          <Txt
            id="chrome.heading_account"
            as="p"
            className="site-mobile-nav-label"
          />
          {/* No prefetch — auth-gated route, see the desktop account link. */}
          <NavLink
            onClick={close}
            prefetch="none"
            to="/account"
            className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <Txt id="chrome.nav_account_signin" />
          </NavLink>
        </>
      ) : null}
    </nav>
  );
}

function HeaderCtas({
  isLoggedIn,
  cart,
}: Pick<HeaderProps, 'isLoggedIn' | 'cart'>) {
  return (
    <nav className="flex items-center gap-2 md:gap-5 ml-auto" role="navigation">
      {/* Hidden in the top bar on phones (it would overflow a 320px row on
          legal pages); MobileMenuAside renders it inside the drawer instead. */}
      <LangToggle className="header-lang-toggle" />
      <NavLink
        prefetch="viewport"
        to="/newsletter"
        className={({isActive}) =>
          `font-mono text-[12px] uppercase tracking-[0.15em] transition-colors hidden md:block ${
            isActive
              ? 'text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`
        }
      >
        <Txt id="chrome.nav_newsletter" />
      </NavLink>
      <NavLink
        prefetch="viewport"
        to="/support"
        className={({isActive}) =>
          `font-mono text-[12px] uppercase tracking-[0.15em] transition-colors hidden md:block ${
            isActive
              ? 'text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`
        }
      >
        <Txt id="chrome.nav_contact" />
      </NavLink>
      {/* No prefetch: /account is auth-gated, so a viewport prefetch fired a
          wasted 400 /account.data request (+ console error) on every single
          pageview for logged-out visitors. */}
      <NavLink
        prefetch="none"
        to="/account"
        className="font-mono text-[12px] uppercase tracking-[0.15em] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors hidden md:block"
      >
        <Suspense fallback={<Txt id="chrome.nav_sign_in" />}>
          <Await
            resolve={isLoggedIn}
            errorElement={<Txt id="chrome.nav_sign_in" />}
          >
            {(isLoggedIn) => (
              <Txt id={isLoggedIn ? 'chrome.nav_account' : 'chrome.nav_sign_in'} />
            )}
          </Await>
        </Suspense>
      </NavLink>
      <ThemeToggle className="site-header-icon" />
      <CartToggle cart={cart} />
      <HeaderMenuMobileToggle />
    </nav>
  );
}

function HeaderMenuMobileToggle() {
  const {open} = useAside();
  return (
    <button
      className="site-header-icon site-header-menu-toggle text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      onClick={() => open('mobile')}
      aria-label={copyText('chrome.menu_toggle_aria') ?? 'Menu'}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="4" y1="7" x2="20" y2="7" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <line x1="4" y1="17" x2="20" y2="17" />
      </svg>
    </button>
  );
}

function CartBadge({count}: {count: number}) {
  const {openPreview, close, type, preview} = useAside();
  const {publish, shop, cart, prevCart} = useAnalytics();
  // Hover (mouse only) opens the drawer as a quick preview — same feel as the
  // family pods; click always commits to the /cart page, which is also the
  // keyboard/touch path. The open goes through a short hover-intent delay so
  // a pointer merely grazing the icon en route to something else never
  // triggers it. The preview is NON-modal (see Aside `openPreview`): no focus
  // steal, no scroll-lock — it closes once the pointer settles outside both
  // the icon and the drawer, and pins to a full modal the moment the visitor
  // interacts inside the drawer (it's a real cart session then, not a peek).
  const previewActive = type === 'cart' && preview;
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // One cart_viewed per drawer open — hover-open publishes, and the
  // commit-click only publishes when no preview already did.
  const viewedRef = useRef(false);

  useEffect(() => {
    if (type !== 'cart') viewedRef.current = false;
  }, [type]);

  useEffect(() => () => clearTimeout(openTimer.current), []);

  // While the preview is open, lift the header above the drawer overlay
  // (html[data-cart-preview] .site-header — same pattern as the family-pod
  // z-index bump) so the cart icon stays hoverable AND clickable: the
  // commit-click must land on the icon, not on the overlay.
  useEffect(() => {
    if (!previewActive) return;
    document.documentElement.setAttribute('data-cart-preview', '');
    return () => document.documentElement.removeAttribute('data-cart-preview');
  }, [previewActive]);

  useEffect(() => {
    if (!previewActive) return;
    // Same global-pointer backstop as FamilyNav: onMouseLeave alone can't
    // bridge the gap between the icon and the drawer panel, so watch the
    // pointer document-wide while the preview is open.
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      clearTimeout(closeTimer.current);
      if (t?.closest?.('.overlay aside') || t?.closest?.('[data-cart-hover]'))
        return;
      closeTimer.current = setTimeout(() => close(), 140);
    };
    // A preview doesn't scroll-lock the body — a wheel spin outside the panel
    // means "get out of my way", so close immediately (pods close on scroll).
    const onWheel = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.overlay aside')) return;
      clearTimeout(closeTimer.current);
      close();
    };
    document.addEventListener('pointermove', onPointer);
    document.addEventListener('wheel', onWheel, {passive: true});
    return () => {
      clearTimeout(closeTimer.current);
      document.removeEventListener('pointermove', onPointer);
      document.removeEventListener('wheel', onWheel);
    };
  }, [previewActive, close]);

  return (
    <NavLink
      prefetch="viewport"
      to="/cart"
      data-cart-target=""
      data-cart-hover=""
      className="site-header-icon text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(closeTimer.current);
        clearTimeout(openTimer.current);
        if (type !== 'closed') return;
        // Hover intent: only open once the pointer has dwelled on the icon.
        openTimer.current = setTimeout(() => {
          openPreview('cart');
          viewedRef.current = true;
          publish('cart_viewed', {
            cart,
            prevCart,
            shop,
            url: window.location.href || '',
          } as CartViewPayload);
        }, 150);
      }}
      onPointerLeave={() => {
        // Grazed, not committed — cancel a pending hover-open. The global
        // pointermove watcher handles closing an already-open preview.
        clearTimeout(openTimer.current);
      }}
      onClick={() => {
        // Committing to the page: drop the preview so the drawer doesn't sit
        // open over /cart after the SPA navigation.
        clearTimeout(openTimer.current);
        clearTimeout(closeTimer.current);
        close();
        if (!viewedRef.current) {
          publish('cart_viewed', {
            cart,
            prevCart,
            shop,
            url: window.location.href || '',
          } as CartViewPayload);
        }
      }}
    >
      {/* Inner relative wrapper keeps the count badge pinned to the icon, not
          to the enlarged 44px tap area the anchor gets on mobile. */}
      <span className="relative inline-flex">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <path d="M16 10a4 4 0 01-8 0" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -right-1.5 bg-[var(--color-gold-fill)] text-[var(--color-on-accent)] text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
            {count}
          </span>
        )}
      </span>
    </NavLink>
  );
}

function CartToggle({cart}: Pick<HeaderProps, 'cart'>) {
  return (
    <Suspense fallback={<CartBadge count={0} />}>
      <Await resolve={cart}>
        <CartBanner />
      </Await>
    </Suspense>
  );
}

function CartBanner() {
  const originalCart = useAsyncValue() as CartApiQueryFragment | null;
  const cart = useOptimisticCart(originalCart);
  return <CartBadge count={cart?.totalQuantity ?? 0} />;
}

const LOCAL_PAGE_REWRITES: Record<string, string> = {
  '/pages/contact': '/support',
};

const FALLBACK_HEADER_MENU = {
  id: 'gid://shopify/Menu/199655587896',
  items: [
    {
      id: 'gid://shopify/MenuItem/461609500728',
      resourceId: null,
      tags: [],
      title: 'Catalog',
      type: 'HTTP',
      url: '/collections/all',
      items: [],
    },
    {
      id: 'gid://shopify/MenuItem/461609566265',
      resourceId: null,
      tags: [],
      title: 'Newsletter',
      type: 'HTTP',
      url: '/newsletter',
      items: [],
    },
    {
      id: 'gid://shopify/MenuItem/461609566264',
      resourceId: null,
      tags: [],
      title: 'Open Source',
      type: 'HTTP',
      url: 'https://github.com/OpenDrone-hw',
      items: [],
    },
  ],
};
