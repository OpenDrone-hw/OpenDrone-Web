import {useEffect, useRef, useState} from 'react';
import {Form, useLocation} from 'react-router';
import {NavLink} from '~/components/nav';
import {AnimatePresence} from 'motion/react';
import {useAside} from '~/components/Aside';
import {LangToggle} from '~/components/LangToggle';
import {ThemeToggle} from '~/components/ThemeToggle';
import {SiteWordmark} from '~/components/SiteWordmark';
import {IncutecWordmark} from '~/components/IncutecWordmark';
import {Pod} from '~/components/Pod';
import {
  ProductPods,
  type ProductPodItem,
  type PodCompanionOption,
} from '~/components/ProductPods';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {CART_UPDATED_EVENT} from '~/lib/cart-client';
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
import {FAMILIES} from '~/lib/families';
import {stackDiscountedPrice} from '~/lib/stack-discount';
import {buyUrl, type CommerceHandoff} from '~/lib/shop-links';
import type {
  ProductCardFragment,
  ProductVariantFragment,
} from '~/lib/product-shapes';

/** Retire the hero "Who's incutec?" hint: persist the dismissal and pull the
 *  class so it can't flash on a same-session SPA return to the homepage. */
function dismissIncutecHint() {
  try {
    localStorage.setItem(INCUTEC_HINT_SEEN_KEY, '1');
  } catch {
    /* storage blocked (private mode) - the nudge just isn't persisted */
  }
  document.documentElement.classList.remove('hero-incutec-hint');
}

/** A product as the header reads it: a catalog card. */
export type HeaderFamilyVariant = ProductVariantFragment;
export type HeaderFamilyProduct = ProductCardFragment;

interface HeaderProps {
  commerceHandoff: CommerceHandoff;
  accountUrl: string | null;
  familyProducts?: HeaderFamilyProduct[];
  /** Checkout is open: the cart icon links to /cart and shows the count. */
  shopOpen?: boolean;
}

type Viewport = 'desktop' | 'mobile';

// The header's own words live in `content/copy/chrome.json` and are rendered
// through <Txt> or copyText. The family labels below also double as dropdown
// state keys, so the code keeps `short`/`long` as the key and fallback and
// only the rendered label reads the copy store (`chrome.family_<slug>_short`,
// `_long`). Product data is never copy.
//
// The family chips. Accessories get no dedicated link: they live (with
// everything else) on the All Products page, reachable via the CTA on the
// right and filterable by family there. Each chip links to its family's
// representative PDP and, on hover, drops a Pod listing every SKU in it.
// The vocabulary itself is app/lib/families.ts, shared with the listing.
const CATEGORY_LINKS = FAMILIES.map((f) => ({
  label: f.short,
  to: f.to,
  type: f.type,
}));

/** Fuller family names for the mobile drawer (the desktop FamilyNav chips
 *  use the terse FC/ESC/… labels; the drawer has room to spell them out). */
const MOBILE_FAMILY_LABEL: Record<string, string> = Object.fromEntries(
  FAMILIES.map((f) => [f.type, f.long]),
);

/** Stack companions per family: each pod row offers "+X" buttons for these
 *  partner products, size-matched by the Model option. N-to-N ready: every
 *  entry in a family's list becomes its own button in the buy cell (they
 *  stack vertically), so a second compatible ESC - or an OpenFC Pro on the
 *  ESC side - is one more `{handle, short}` here. Keep `short` unique per
 *  list ("ESC 30×30", "FC PRO") once a family has two partners, since it's
 *  the visible label. Only the pairing lives here; the discount claim (the
 *  automatic BXGY's percent and which ONE board of the pair it is off,
 *  today the OpenESC, never both) derives per row from that product's
 *  `stack` config in product-content.ts, which is only set while Shopify
 *  carries the matching discount, so an unconfigured shop claims nothing. */
const STACK_COMPANIONS: Record<string, Array<{handle: string; short: string}>> = {
  'Flight Controller': [{handle: 'openesc', short: 'ESC'}],
  '4-in-1 ESC': [{handle: 'openfc-lite', short: 'FC'}],
};

/** Copy slug of a family: the suffix of its listing copy id
 *  (`collections-all.category_esc` -> `esc`). */
function familySlug(type: string): string | undefined {
  return FAMILIES.find((f) => f.type === type)?.copyId.split('.category_')[1];
}

/** Rendered chip label ("FC", "ESC") for a family, editable in the studio. */
function familyShort(type: string, fallback: string): string {
  const slug = familySlug(type);
  return (slug ? copyText(`chrome.family_${slug}_short`) : undefined) ?? fallback;
}

/** Rendered drawer label ("Flight Controllers") for a family. */
function familyLong(type: string, fallback: string): string {
  const slug = familySlug(type);
  return (slug ? copyText(`chrome.family_${slug}_long`) : undefined) ?? fallback;
}

/** Rendered "+X" label of a stack companion button. */
function companionShort(handle: string, fallback: string): string {
  return copyText(`chrome.stack_companion_${handle}_short`) ?? fallback;
}


/** Families bought in sets: a row also offers "×N" (a quad takes four
 *  motors), one click for N units. */
const SET_OF: Record<string, number> = {Motors: 4};

function selfShortFor(type: string): string {
  const label = CATEGORY_LINKS.find((c) => c.type === type)?.label;
  return label
    ? familyShort(type, label)
    : (copyText('chrome.family_fallback_short') ?? 'board');
}

export function Header({
  commerceHandoff,
  accountUrl,
  familyProducts,
  shopOpen = false,
}: HeaderProps) {
  // Dynamic-Island logo slot. On the hero ("/") the OpenDrone wordmark already
  // lives bottom-left in the 3D scene, so the bar instead credits the parent
  // company - the Incutec mark linking to incutec.eu (OpenDrone is an Incutec
  // product brand). On every other route the slot is the OpenDrone wordmark
  // home link. The slot is a fixed width so the nav chips never shift between
  // routes; view-transition-name animates the swap across navigations.
  const {pathname} = useLocation();
  const isHero = pathname === '/';
  return (
    <header className="site-header">
      <div className="site-header-main">
        {/* Left: brand slot - OpenDrone home link, or Incutec credit on the hero.
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
            prefetch="intent"
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
        <HeaderMenu viewport="desktop" accountUrl={accountUrl} />
        {/* Category families in segmented bubbles: FC and ESC share one
            (their rows sell the stack), while RX, Motors and Frame are standalone
            families so each gets its own bubble; All Products follows in its
            own accented bubble as the route into the full catalogue. No
            dividers - the bubbles do the grouping. */}
        <FamilyNav familyProducts={familyProducts} commerceHandoff={commerceHandoff} />

        {/* Right: actions */}
        <HeaderCtas
          accountUrl={accountUrl}
          cartUrl={shopOpen ? '/cart' : commerceHandoff.cartUrl}
          hasCart={commerceHandoff.cartUrl !== null}
        />
      </div>
    </header>
  );
}

/**
 * The gold family chips (FC/ESC/Stack/RX/Motors/Frame) - segmented bubbles that, on
 * hover/focus, drop a Pod listing every SKU of that productType (thumbnail +
 * title + price). The chip itself still links to the family's PDP. Deferred
 * product data is resolved once on first hover so the chips render instantly.
 * Desktop-only (the nav is hidden below 900px). Same Pod material + popOpen
 * motion as the hero showcase.
 */
function FamilyNav({
  familyProducts,
  commerceHandoff,
}: {
  familyProducts?: HeaderFamilyProduct[];
  commerceHandoff: CommerceHandoff;
}) {
  const products = familyProducts ?? null;
  const [open, setOpen] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // True for the tick after Escape restores focus to a chip (see onFocus).
  const escFocus = useRef(false);
  const location = useLocation();
  // Global coming-soon flag; per-product overrides resolve in isComingSoon()
  // below so unlaunched SKUs list without price or buy cell.
  const productStatus = useProductStatusResolver();
  const roadmapStatus = useRoadmapStatusResolver();

  // Close the hover dropdown on any navigation - otherwise clicking a SKU drops
  // you on the page with the menu still stuck open (mouseleave never fires when
  // the pointer is over the navigating link).
  useEffect(() => {
    clearTimeout(closeTimer.current);
    setOpen(null);
  }, [location.pathname, location.search]);

  function openFamily(label: string) {
    clearTimeout(closeTimer.current);
    setOpen(label);
  }
  function scheduleClose() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(null), 140);
  }

  // Backstop for the hover dropdown: onMouseLeave/onBlur are not reliable - a
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
    const options = cfg.flatMap(({handle: h, short: shortCode}) => {
      const short = companionShort(h, shortCode);
      // Unlaunched partners can't cascade into a stack add.
      if (!isPurchasableStatus(productStatus(h))) return [];
      const partner = (products ?? []).find((p) => p.handle === h);
      const pv = partner?.variants.nodes.find((pvv) =>
        pvv.selectedOptions.some(
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
          // Both SKUs on one hand-off link.
          href: buyUrl(commerceHandoff, [
            {sku: v.sku ?? '', quantity: 1},
            {sku: pv.sku ?? '', quantity: 1},
          ]),
        },
      ];
    });
    return options.length ? options : undefined;
  }

  function setFor(type: string, sku: string | null | undefined) {
    const quantity = SET_OF[type];
    if (!quantity || !sku) return undefined;
    return {quantity, href: buyUrl(commerceHandoff, [{sku, quantity}])};
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
        // no price and no buy cell - the PDP hosts the notify signup.
        const soon = !isPurchasableStatus(productStatus(p.handle));
        // Real, distinguishable variants (drop the single "Default Title").
        const variants = (p.variants.nodes ?? []).filter(
          (v) => v.title && v.title !== 'Default Title',
        );
        // Single-variant product → one row for the product itself.
        if (variants.length <= 1) {
          const only = p.variants.nodes[0];
          return [
            {
              key: p.handle,
              to: `/products/${p.handle}`,
              title: p.title,
              subtitle: p.productType ?? undefined,
              imageUrl: p.featuredImage?.url ?? null,
              imageAlt: p.featuredImage?.altText ?? null,
              price: soon ? null : (p.priceRange.minVariantPrice ?? null),
              soon,
              buy: soon
                ? undefined
                : only
                ? {
                    href: only.cartAddUrl,
                    product: p.handle,
                    available: Boolean(only.availableForSale),
                    selfShort: selfShortFor(type),
                    set: setFor(type, only.sku),
                  }
                : undefined,
            },
          ];
        }
        // Multi-variant → a row per SKU, deep-linking the variant on the PDP.
        return variants.map((v) => {
          const params = new URLSearchParams();
          v.selectedOptions.forEach((o) => params.set(o.name, o.value));
          const qs = params.toString();
          return {
            key: v.sku ?? v.id,
            to: `/products/${p.handle}${qs ? `?${qs}` : ''}`,
            // SKU/variant name is the headline (gold); the family line is the
            // dim context beneath it.
            title: v.title,
            subtitle: p.title,
            imageUrl: v.image?.url ?? p.featuredImage?.url ?? null,
            imageAlt: v.image?.altText ?? p.featuredImage?.altText ?? null,
            price: soon ? null : (v.price ?? p.priceRange.minVariantPrice ?? null),
            soon,
            buy: soon
              ? undefined
              : {
                  href: v.cartAddUrl,
                  product: p.handle,
                  available: Boolean(v.availableForSale),
                  selfShort: selfShortFor(type),
                  set: setFor(type, v.sku),
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
      // The wrapper itself isn't interactive - the chip link and pod rows
      // inside are. onKeyDown here is a container-level Escape listener so
      // Escape works from anywhere within the open pod.
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div
        className="header-cat"
        key={cat.label}
        onMouseEnter={() => openFamily(cat.label)}
        onMouseLeave={scheduleClose}
        onFocus={() => {
          // Swallow the focus event caused by Escape's own focus restore -
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
          prefetch="intent"
          to={cat.to}
          aria-expanded={open === cat.label}
        >
          {familyShort(cat.type, cat.label)}
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
                ariaLabel={(
                  copyText('chrome.family_pod_aria') ?? '{family} products'
                ).replace('{family}', familyShort(cat.type, cat.label))}
              >
                <ProductPods
                  items={items}
                  layout="row"
                  onAdd={() => setOpen(null)}
                />
              </Pod>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  return (
    <nav
      className="site-header-categories"
      aria-label={copyText('chrome.categories_aria') ?? 'Product categories'}
    >
      {/* FC and ESC share one bubble (a stack is bought from their rows);
          RX, Motors and Frame are standalone families with their own bubbles. */}
      <span className="site-header-cat-group">
        {CATEGORY_LINKS.slice(0, 2).map(chip)}
      </span>
      {CATEGORY_LINKS.slice(2).map((cat) => (
        <span className="site-header-cat-group" key={cat.label}>
          {chip(cat)}
        </span>
      ))}
      <NavLink
        prefetch="intent"
        to="/products"
        className="site-header-cat-all"
      >
        <Txt id="chrome.nav_all_products" />
      </NavLink>
    </nav>
  );
}

export function HeaderMenu({
  viewport,
  accountUrl,
}: {
  viewport: Viewport;
  accountUrl: string | null;
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
          which is hidden on phones - without this the drawer was four links in
          a sea of empty panel and the whole product taxonomy vanished. */}
      {isMobile && (
        <>
          {/* The listing filters the catalog client-side, so this is a
              plain GET form onto it rather than a search API call. */}
          <Form
            action="/products"
            method="get"
            className="site-mobile-nav-search"
            onSubmit={() => close()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
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
          </Form>
          <Txt
            id="chrome.heading_shop"
            as="p"
            className="site-mobile-nav-label"
          />
          {CATEGORY_LINKS.map((c) => (
            <NavLink
              key={c.to}
              onClick={close}
              prefetch="intent"
              to={c.to}
              className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              {familyLong(c.type, MOBILE_FAMILY_LABEL[c.type] ?? c.label)}
            </NavLink>
          ))}
          <NavLink
            onClick={close}
            prefetch="intent"
            to="/products"
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
            prefetch="intent"
            to="/"
            className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <Txt id="chrome.nav_home" />
          </NavLink>
        </>
      )}
      {HEADER_MENU.items.map((item) => {
        if (!item.url) return null;
        const url = item.url;
        // Desktop already exposes these destinations in its category bar,
        // action links or footer. The mobile drawer keeps the full menu.
        if (
          !isMobile &&
          (url === '/preorder' ||
            url === '/wholesale' ||
            url === '/products' ||
            url === '/support' ||
            url === '/newsletter' ||
            url === 'https://github.com/OpenDrone-hw')
        )
          return null;
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
              {menuTitle(item)}
            </a>
          );
        }

        return (
          <NavLink
            end
            key={item.id}
            onClick={close}
            prefetch="intent"
            to={url}
            className={({isActive}) =>
              `${isMobile ? 'text-sm tracking-wider' : 'text-[12px] tracking-[0.15em]'} font-mono uppercase transition-colors ${
                isActive
                  ? 'text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
              }`
            }
          >
            {menuTitle(item)}
          </NavLink>
        );
      })}
      {/* Mobile aside only: a Newsletter link in the slide-out menu. On
          desktop Newsletter lives in the right-side CTA group (left of
          Catalog), so it's omitted here to avoid duplicating it. Skipped if
          HEADER_MENU already links to /newsletter. */}
      {isMobile &&
      !HEADER_MENU.items.some((it) => it.url?.includes('/newsletter')) ? (
        <NavLink
          end
          onClick={close}
          prefetch="intent"
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
      {isMobile && accountUrl ? (
        <>
          <Txt
            id="chrome.heading_account"
            as="p"
            className="site-mobile-nav-label"
          />
          {/* Accounts live in Shopify customer accounts, so this leaves
              the site rather than routing inside it. */}
          <a
            onClick={close}
            href={accountUrl}
            className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <Txt id="chrome.nav_account_signin" />
          </a>
        </>
      ) : null}
    </nav>
  );
}

function HeaderCtas({
  accountUrl,
  cartUrl,
  hasCart,
}: {
  accountUrl: string | null;
  cartUrl: string | null;
  hasCart: boolean;
}) {
  return (
    <nav className="flex items-center gap-2 md:gap-5 ml-auto" role="navigation">
      {/* Hidden in the top bar on phones (it would overflow a 320px row on
          legal pages); MobileMenuAside renders it inside the drawer instead. */}
      <LangToggle className="header-lang-toggle" />
      <NavLink
        prefetch="intent"
        to="/preorder"
        className={({isActive}) =>
          `font-mono text-[12px] uppercase tracking-[0.15em] transition-colors hidden md:block ${
            isActive
              ? 'text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`
        }
      >
        <Txt id="chrome.nav_preorder" />
      </NavLink>
      <NavLink
        prefetch="intent"
        to="/wholesale"
        className={({isActive}) =>
          `font-mono text-[12px] uppercase tracking-[0.15em] transition-colors hidden md:block ${
            isActive
              ? 'text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`
        }
      >
        <Txt id="chrome.nav_trade" />
      </NavLink>
      <NavLink
        prefetch="intent"
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
      {/* Account, orders and addresses live in Shopify customer accounts:
          an external link, not an in-app route. The signed-in state is
          Shopify's to know, so the label is always "Account". */}
      {accountUrl ? (
        <a
          href={accountUrl}
          className="font-mono text-[12px] uppercase tracking-[0.15em] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors hidden md:block"
        >
          <Txt id="chrome.nav_account" />
        </a>
      ) : null}
      <ThemeToggle className="site-header-icon" />
      <CartToggle cartUrl={cartUrl} hasCart={hasCart} />
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

/**
 * The cart icon links, after the first add or whenever the shop is open, to
 * the local cart page, with a count badge once the session's cart has items.
 */
function CartToggle({cartUrl, hasCart}: {cartUrl: string | null; hasCart: boolean}) {
  const [quantity, setQuantity] = useState(0);
  useEffect(() => {
    if (!cartUrl || !hasCart) {
      setQuantity(0);
      return;
    }
    let live = true;
    fetch('/api/shopify/cart?summary=1', {credentials: 'same-origin'})
      .then((r) => (r.ok ? (r.json() as Promise<{totalQuantity?: number}>) : null))
      .then((d) => {
        if (live && typeof d?.totalQuantity === 'number') setQuantity(d.totalQuantity);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cartUrl, hasCart]);
  useEffect(() => {
    const update = (event: Event) => {
      const total = (event as CustomEvent<{totalQuantity?: number}>).detail?.totalQuantity;
      if (typeof total === 'number') setQuantity(total);
    };
    window.addEventListener(CART_UPDATED_EVENT, update);
    return () => window.removeEventListener(CART_UPDATED_EVENT, update);
  }, []);
  if (!cartUrl) {
    return (
      <span
        className="site-header-icon site-header-cart"
        aria-label={
          copyText('chrome.cart_unavailable_aria') ??
          'Cart unavailable in checkout preview'
        }
        aria-disabled="true"
      >
        <CartIcon />
      </span>
    );
  }
  return (
    <a
      className="site-header-icon site-header-cart"
      href={cartUrl}
      aria-label={`${copyText('chrome.cart_aria') ?? 'Cart'}${quantity ? ` (${quantity})` : ''}`}
    >
      <CartIcon />
      {quantity > 0 ? (
        <span className="site-header-cart-count">{quantity > 99 ? '99+' : quantity}</span>
      ) : null}
    </a>
  );
}

function CartIcon() {
  return (
    <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <circle cx="9" cy="20" r="1.5" />
        <circle cx="18" cy="20" r="1.5" />
        <path d="M2 3h3l2.4 12.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6" />
    </svg>
  );
}

/**
 * The site menu. It used to be edited in the Shopify admin and read
 * through the Storefront API; it is these few links. The id and url are
 * structure; the rendered title reads `chrome.menu_<id>` and falls back to
 * `title` here.
 */
function menuTitle(item: {id: string; title: string}): string {
  return copyText(`chrome.${item.id.replace(/-/g, '_')}`) ?? item.title;
}

const HEADER_MENU = {
  items: [
    {id: 'menu-products', title: 'Catalog', url: '/products'},
    {id: 'menu-preorder', title: 'Preorders', url: '/preorder'},
    {id: 'menu-wholesale', title: 'Wholesale', url: '/wholesale'},
    {id: 'menu-newsletter', title: 'Newsletter', url: '/newsletter'},
    {
      id: 'menu-open-source',
      title: 'Open Source',
      url: 'https://github.com/OpenDrone-hw',
    },
  ],
};
