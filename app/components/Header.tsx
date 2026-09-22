import {DISCORD_INVITE_URL} from '~/lib/company';
import {CART_UPDATED_EVENT} from '~/lib/cart-client';
import {useEffect, useRef, useState} from 'react';
import {Form, useLocation} from 'react-router';
import {NavLink} from '~/components/nav';
import {AnimatePresence} from 'motion/react';
import {useAside} from '~/components/Aside';
import {LangToggle, legalHref, useLegalLocale} from '~/components/LangToggle';
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
  /** Checkout is open: the cart icon always links to the cart, even before
   *  the first add, as on any shop. */
  shopOpen?: boolean;
}

type Viewport = 'desktop' | 'mobile';

// The header's own words live in `content/copy/chrome.json` and are rendered
// through <Txt>. Three sets of strings deliberately do NOT: the site menu
// titles in HEADER_MENU below, anything derived from product data, and the
// family labels below - those double as dropdown state keys and as the short
// names on the buy buttons, so they are structure, not copy.
//
// The family chips. Accessories get no dedicated link: they live (with
// everything else) on the All Products page, reachable via the CTA on the
// right and filterable by family there. Each chip links to its family's
// representative PDP and, on hover, drops a Pod listing every SKU in it.
// The vocabulary itself is app/lib/families.ts, shared with the listing.
//
// Motors have a chip and a drawer entry but no FAMILIES entry: the listing
// rail already labels the "Motors" family from the content file, and a
// FAMILIES entry would need a rail heading in the copy store.
const MOTORS_LINK = {
  label: 'Motors',
  long: 'Motors',
  to: '/products/openmotor',
  type: 'Motors',
};
const CATEGORY_LINKS = [
  ...FAMILIES.map((f) => ({
    label: f.short,
    to: f.to,
    type: f.type,
  })),
  {label: MOTORS_LINK.label, to: MOTORS_LINK.to, type: MOTORS_LINK.type},
];

/** Fuller family names for the mobile drawer (the desktop FamilyNav chips
 *  use the terse FC/ESC/… labels; the drawer has room to spell them out). */
const MOBILE_FAMILY_LABEL: Record<string, string> = Object.fromEntries([
  ...FAMILIES.map((f) => [f.type, f.long]),
  [MOTORS_LINK.type, MOTORS_LINK.long],
]);

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

/** Short family label ("FC", "ESC") for a family type. */

function selfShortFor(type: string): string {
  return CATEGORY_LINKS.find((c) => c.type === type)?.label ?? 'board';
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
        <HeaderMenu viewport="desktop" accountUrl={accountUrl} />
        {/* Category families in segmented bubbles: FC and ESC share one
            (their rows sell the stack), while RX and Frame are standalone
            families so each gets its own bubble; All Products follows in its
            own accented bubble as the route into the full catalogue. No
            dividers - the bubbles do the grouping. */}
        <FamilyNav familyProducts={familyProducts} commerceHandoff={commerceHandoff} />

        {/* Right: actions */}
        <HeaderCtas
          accountUrl={accountUrl}
          cartUrl={commerceHandoff.cartUrl ?? (shopOpen ? '/cart' : null)}
          hasCart={commerceHandoff.cartUrl !== null}
          shopOpen={shopOpen}
        />
      </div>
    </header>
  );
}

/**
 * The gold family chips (FC/ESC/Stack/RX/Frame) - segmented bubbles that, on
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
    const options = cfg.flatMap(({handle: h, short}) => {
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
        // Tabbing onto a chip does not open its pod, so a keyboard user
        // passes the header in one stop per category. Arrow Down opens it and
        // moves into the products; focus inside an open pod keeps it open.
        onFocus={() => {
          if (!escFocus.current && open === cat.label) clearTimeout(closeTimer.current);
        }}
        onBlur={scheduleClose}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length > 0) {
            e.preventDefault();
            openFamily(cat.label);
            const wrap = e.currentTarget;
            setTimeout(() => {
              wrap.querySelector<HTMLElement>('.header-cat-pod a, .header-cat-pod button')?.focus();
            }, 50);
            return;
          }
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
    <nav className="site-header-categories" aria-label="Product categories">
      {/* FC and ESC share one bubble (a stack is bought from their rows);
          RX stands alone; Frame and Motors share the last bubble, which
          keeps the row inside the header pill at 1024px. */}
      <span className="site-header-cat-group">
        {CATEGORY_LINKS.slice(0, 2).map(chip)}
      </span>
      <span className="site-header-cat-group">
        {CATEGORY_LINKS.slice(2, 3).map(chip)}
      </span>
      <span className="site-header-cat-group">
        {CATEGORY_LINKS.slice(3).map(chip)}
      </span>
      <NavLink
        prefetch="viewport"
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
  const legalLocale = useLegalLocale();

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
            prefetch="viewport"
            to="/"
            className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <Txt id="chrome.nav_home" />
          </NavLink>
        </>
      )}
      {HEADER_MENU.items.map((item) => {
        if (!item.url) return null;
        const url = legalHref(item.url, legalLocale);
        // Preorders and Contact render in the right-side CTA group, and
        // Newsletter and Open Source render there / in the footer too
        // (HeaderCtas below, and the footer's "Open Source & Incutec"
        // link): skip all four here on desktop so the center menu isn't
        // a duplicate row. Production's live center nav is empty for the
        // same reason (mirrors that empty `<nav>` byte-for-byte). Mobile
        // keeps every item since the drawer has no CTA group to fall
        // back on.
        if (
          !isMobile &&
          (url === '/preorder' ||
            url === '/support' ||
            item.url === '/shipping' ||
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
          HEADER_MENU already links to /newsletter. */}
      {isMobile &&
      !HEADER_MENU.items.some((it) => it.url?.includes('/newsletter')) ? (
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
  shopOpen,
}: {
  accountUrl: string | null;
  cartUrl: string | null;
  hasCart: boolean;
  shopOpen: boolean;
}) {
  return (
    <nav className="flex items-center gap-2 md:gap-3 xl:gap-5 ml-auto" role="navigation">
      {/* Hidden in the top bar on phones (it would overflow a 320px row on
          legal pages); MobileMenuAside renders it inside the drawer instead. */}
      {/* Only on legal pages: the shop is in English, and the footer line
          "The shop is in English. Legal texts:" links the NL/FR legal texts. */}
      <LangToggle className="header-lang-toggle" shopPages={false} />
      <NavLink
        prefetch="viewport"
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
      {/* While the shop is closed the newsletter is the way to hear about the
          launch; once it is open the header carries the shopping links and
          the newsletter lives in the footer. */}
      {shopOpen ? null : (
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
      )}
      {/* Below 1024px the row has no room for it; the footer carries it. */}
      <NavLink
        prefetch="viewport"
        to="/support"
        className={({isActive}) =>
          `font-mono text-[12px] uppercase tracking-[0.15em] transition-colors hidden lg:block ${
            isActive
              ? 'text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`
        }
      >
        <Txt id="chrome.nav_support" />
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
      <HeaderSearch />
      {/* Community: the source and the people, one click from every page.
          Between the tablet and 1280px breakpoints the shop links need the
          room, so the two icons step out there (the drawer and footer keep
          them). */}
      <span className="inline-flex items-center gap-2 md:hidden xl:inline-flex xl:gap-5">
      <a
        className="site-header-icon hidden md:inline-flex"
        href="https://github.com/OpenDrone-hw"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="GitHub"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      </a>
      <a
        className="site-header-icon hidden md:inline-flex"
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Discord"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />
        </svg>
      </a>
      </span>
      <ThemeToggle className="site-header-icon" />
      <CartToggle cartUrl={cartUrl} hasCart={hasCart} />
      <HeaderMenuMobileToggle />
    </nav>
  );
}

/**
 * Desktop header search: a magnifier that opens a one-field GET form onto
 * the product listing, which filters the catalog by `q` (the same target as
 * the mobile drawer's search field and /search). Escape or a click outside
 * closes it.
 */
function HeaderSearch() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  const label = copyText('chrome.search_placeholder') ?? 'Search products';
  return (
    // Container-level Escape listener; the button and the field inside are
    // the interactive elements.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={wrap}
      className="relative hidden md:inline-flex"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          wrap.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        type="button"
        className="site-header-icon text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
      {open ? (
        <Form
          action="/products"
          method="get"
          role="search"
          className="absolute right-0 top-full mt-3 z-50 flex items-center gap-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-2 shadow-lg"
          style={{width: 'min(22rem, 70vw)', maxWidth: 'none'}}
          onSubmit={() => setOpen(false)}
        >
          <input
            ref={input}
            type="search"
            name="q"
            placeholder={label}
            aria-label={label}
            enterKeyHint="search"
            className="flex-1 min-w-0 text-sm"
          />
          <button
            type="submit"
            aria-label={label}
            className="inline-flex p-2 text-[var(--color-gold-text)] hover:text-[var(--color-gold-text-hover)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </Form>
      ) : null}
    </div>
  );
}

function HeaderMenuMobileToggle() {
  const {open, type} = useAside();
  return (
    <button
      className="site-header-icon site-header-menu-toggle text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      onClick={() => open('mobile')}
      aria-expanded={type === 'mobile'}
      aria-haspopup="dialog"
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
 * The cart icon links to the cart page whenever checkout is open, and shows
 * the item count once this session has a Shopify cart.
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
      <span className="site-header-icon site-header-cart" role="img" aria-label="Cart unavailable">
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
 * through the Storefront API; it is these few links. Titles stay here rather than in the copy store for the same
 * reason they always did: they are structure shared with the CTA group,
 * not editable prose.
 */
const HEADER_MENU = {
  items: [
    {id: 'menu-preorder', title: 'Preorders', url: '/preorder'},
    {id: 'menu-support', title: 'Support', url: '/support'},
    {id: 'menu-shipping', title: 'Shipping', url: '/shipping'},
    {id: 'menu-newsletter', title: 'Newsletter', url: '/newsletter'},
    {
      id: 'menu-open-source',
      title: 'Open Source',
      url: 'https://github.com/OpenDrone-hw',
    },
  ],
};
