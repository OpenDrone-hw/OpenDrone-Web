import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {KeyboardEvent} from 'react';
import {Form, useLocation} from 'react-router';
import {Link, NavLink} from '~/components/nav';
import {useAside} from '~/components/Aside';
import {useHeaderPopover} from '~/components/header-popover';
import {RegionSwitch} from '~/components/RegionSwitch';
import {SiteWordmark} from '~/components/SiteWordmark';
import {IncutecWordmark} from '~/components/IncutecWordmark';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {CART_UPDATED_EVENT} from '~/lib/cart-client';
import {INCUTEC_HINT_SEEN_KEY} from '~/lib/incutec-hint';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
import {isConceptFor} from '~/lib/product-content';
import {
  BAR_LINKS,
  SHOP_EXTRAS,
  SHOP_FAMILIES,
  isShopPath,
  type NavLinkItem,
  type ShopFamily,
} from '~/lib/header-nav';
import {shopifyImageUrl} from '~/lib/shopify-image';
import type {CommerceHandoff} from '~/lib/shop-links';
import type {ProductCardFragment} from '~/lib/product-shapes';

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
export type HeaderFamilyProduct = ProductCardFragment;

interface HeaderProps {
  commerceHandoff: CommerceHandoff;
  accountUrl: string | null;
  /** The catalog cards; the Shop panel takes one thumbnail per family. */
  familyProducts?: HeaderFamilyProduct[];
  /** Checkout is open: the cart icon links to /cart and shows the count. */
  shopOpen?: boolean;
}

// The header's own words live in `content/copy/chrome.json` and are rendered
// through <Txt> or copyText. Product data is never copy. The structure (which
// families and links exist, in what order) is app/lib/header-nav.ts.

/** Rendered family label ("Flight Controllers"), editable in the studio. */
function familyLabel(f: ShopFamily): string {
  return copyText(`chrome.family_${f.slug}_long`) ?? f.label;
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
  // home link. The slot is a fixed width so the nav never shifts between
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
              to="/open-source"
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
              to="/open-source"
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

        {/* Centre: one plain-text nav. Three zones on a grid (logo | nav |
            actions) with the nav in the exact middle. Hidden at 959px and
            narrower, where the drawer carries it. */}
        <PrimaryNav familyProducts={familyProducts} />

        {/* Right: region, account, cart (and the menu button on phones) */}
        <HeaderCtas
          accountUrl={accountUrl}
          cartUrl={shopOpen ? '/cart' : commerceHandoff.cartUrl}
          hasCart={commerceHandoff.cartUrl !== null}
        />
      </div>
    </header>
  );
}

const linkClass = ({isActive}: {isActive: boolean}) =>
  `site-header-link${isActive ? ' is-active' : ''}`;

/** Shop, Preorders, Newsletter, Support: one type style, the current page
 *  underlined. The underline is a pseudo-element, so no item ever moves. */
function PrimaryNav({familyProducts}: {familyProducts?: HeaderFamilyProduct[]}) {
  return (
    <nav
      className="site-header-nav"
      aria-label={copyText('chrome.nav_primary_aria') ?? 'Main'}
    >
      <ul>
        <li className="header-shop-item">
          <ShopMenu familyProducts={familyProducts} />
        </li>
        {BAR_LINKS.map((l) => (
          <li key={l.to} className={l.collapses ? 'header-nav-collapse' : undefined}>
            <NavLink prefetch="intent" to={l.to} className={linkClass}>
              <Txt id={l.copy} />
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * "Shop": a disclosure with a panel of the product families (thumbnail and
 * name), the whole catalogue and Wholesale. Opens on mouse hover and on click
 * (a click pins it; a second click closes). Keyboard: Tab to the button,
 * Enter or Space opens, ArrowDown moves onto the first link, arrows, Home and
 * End move between links, Tab walks them in order, Escape closes and returns
 * to the button. Focus leaving the panel, a press outside or a navigation
 * closes it too (useHeaderPopover). Touch has no hover, so a tap opens it.
 */
function ShopMenu({familyProducts}: {familyProducts?: HeaderFamilyProduct[]}) {
  const {pathname, search} = useLocation();
  const {open, setOpen, close, rootRef, triggerRef, onBlur} = useHeaderPopover();
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const pendingFocus = useRef(false);
  const roadmapStatus = useRoadmapStatusResolver();

  useEffect(() => {
    if (!open) pinned.current = false;
  }, [open]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // One thumbnail per family: the first shown product of that family. Planned
  // products have no settled image yet (docs/product-status.md).
  const thumbs = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of familyProducts ?? []) {
      const type = p.productType || '';
      const url = p.featuredImage?.url;
      if (!url || out.has(type)) continue;
      if (isConceptFor(p.handle, roadmapStatus(p.handle))) continue;
      out.set(type, url);
    }
    return out;
  }, [familyProducts, roadmapStatus]);

  const links = useCallback(
    () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>('a[href]') ?? []).filter(
        (el) => el.offsetParent !== null,
      ),
    [],
  );

  // ArrowDown from the button opens the panel and lands on its first link.
  useEffect(() => {
    if (open && pendingFocus.current) {
      pendingFocus.current = false;
      links()[0]?.focus();
    }
  }, [open, links]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const onTrigger = e.target === triggerRef.current;
    if (onTrigger) {
      if (e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (open) links()[0]?.focus();
      else {
        pendingFocus.current = true;
        pinned.current = true;
        setOpen(true);
      }
      return;
    }
    const list = links();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next = -2;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % list.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = at - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next === -2) return;
    e.preventDefault();
    if (next < 0) triggerRef.current?.focus();
    else list[next]?.focus();
  };

  const activeType = pathname === '/products' ? new URLSearchParams(search).get('type') : null;
  const current = isShopPath(pathname);
  const shopLabel = copyText('chrome.nav_shop') ?? 'Shop';

  const closeNow = () => close();
  const familyCurrent = (f: ShopFamily) => activeType === f.type;
  const extraCurrent = (l: NavLinkItem) =>
    l.to === '/products'
      ? pathname === '/products' && !activeType
      : pathname === l.to;

  return (
    // The wrapper is not interactive: its trigger and links are. The handlers
    // give hover intent and arrow-key movement across the whole widget.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={rootRef}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className="header-popover header-shop"
      data-open={open ? 'true' : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(hoverTimer.current);
        setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse' || pinned.current) return;
        clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setOpen(false), 160);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`site-header-link header-shop-trigger${current ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-current={current ? 'page' : undefined}
        onClick={() => {
          if (!open) {
            pinned.current = true;
            setOpen(true);
          } else if (!pinned.current) {
            pinned.current = true;
          } else {
            pinned.current = false;
            setOpen(false);
          }
        }}
      >
        {shopLabel}
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {open ? (
        <div id={panelId} ref={panelRef} className="header-shop-panel">
          <nav aria-label={shopLabel} className="header-shop-grid">
            <ul className="header-shop-families">
              {SHOP_FAMILIES.map((f) => {
                const thumb = thumbs.get(f.type);
                return (
                  <li key={f.type}>
                    <Link
                      prefetch="intent"
                      to={f.to}
                      className="header-shop-family"
                      aria-current={familyCurrent(f) ? 'page' : undefined}
                      onClick={closeNow}
                    >
                      <span className="header-shop-thumb" aria-hidden="true">
                        {thumb ? (
                          <img
                            src={shopifyImageUrl(thumb, 160)}
                            width={40}
                            height={40}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                        ) : null}
                      </span>
                      <span className="header-shop-family-text">
                        <span>{familyLabel(f)}</span>
                        {f.noteCopy ? (
                          <small>
                            <Txt id={f.noteCopy} />
                          </small>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <ul className="header-shop-extras">
              {SHOP_EXTRAS.map((l) => (
                <li key={l.to}>
                  <Link
                    prefetch="intent"
                    to={l.to}
                    aria-current={extraCurrent(l) ? 'page' : undefined}
                    onClick={closeNow}
                  >
                    <Txt id={l.copy} />
                  </Link>
                </li>
              ))}
              {/* Tablet widths: Newsletter folds in here from the bar. */}
              {BAR_LINKS.filter((l) => l.collapses).map((l) => (
                <li key={l.to} className="header-shop-collapsed">
                  <Link
                    prefetch="intent"
                    to={l.to}
                    aria-current={pathname === l.to ? 'page' : undefined}
                    onClick={closeNow}
                  >
                    <Txt id={l.copy} />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The phone drawer. Every destination of the bar and of the Shop panel, then
 * the account link; PageLayout adds region, theme and language below.
 */
export function HeaderMenu({accountUrl}: {accountUrl: string | null}) {
  const {close} = useAside();
  const { pathname, search } = useLocation();
  const activeType = pathname === '/products' ? new URLSearchParams(search).get('type') : null;
  const item = (to: string, label: React.ReactNode, current: boolean) => (
    <Link
      key={to}
      onClick={close}
      prefetch="intent"
      to={to}
      className="site-mobile-link"
      aria-current={current ? 'page' : undefined}
    >
      {label}
    </Link>
  );

  return (
    <nav className="site-mobile-nav flex flex-col gap-1 px-1" aria-label={copyText('chrome.nav_primary_aria') ?? 'Main'}>
      {/* The listing filters the catalog client-side, so this is a plain GET
          form onto it rather than a search API call. */}
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
          placeholder={copyText('chrome.search_placeholder') ?? 'Search products'}
          aria-label={copyText('chrome.search_placeholder') ?? 'Search products'}
          enterKeyHint="search"
        />
      </Form>
      <Txt id="chrome.heading_shop" as="p" className="site-mobile-nav-label" />
      {SHOP_FAMILIES.map((f) => item(f.to, familyLabel(f), activeType === f.type))}
      {item(
        '/products',
        <Txt id="chrome.nav_all_products" />,
        pathname === '/products' && !activeType,
      )}
      <Txt id="chrome.heading_more" as="p" className="site-mobile-nav-label" />
      {BAR_LINKS.map((l) => item(l.to, <Txt id={l.copy} />, pathname === l.to))}
      {SHOP_EXTRAS.filter((l) => l.to !== '/products').map((l) =>
        item(l.to, <Txt id={l.copy} />, pathname === l.to),
      )}
      {accountUrl ? (
        <>
          <Txt id="chrome.heading_account" as="p" className="site-mobile-nav-label" />
          {/* Accounts live in Shopify customer accounts, so this leaves the
              site rather than routing inside it. */}
          <a onClick={close} href={accountUrl} className="site-mobile-link">
            <Txt id="chrome.nav_account_signin" />
          </a>
        </>
      ) : null}
    </nav>
  );
}

function AccountIcon() {
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
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7" />
    </svg>
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
    <div className="site-header-actions">
      {/* Hidden in the bar at 959px and narrower: the drawer carries the
          region switch and the account link there. */}
      <RegionSwitch variant="menu" className="header-region-switch" />
      {/* Account, orders and addresses live in Shopify customer accounts:
          an external link, not an in-app route. The signed-in state is
          Shopify's to know, so the label is always "Account". */}
      {accountUrl ? (
        <a
          href={accountUrl}
          className="site-header-icon site-header-account"
          aria-label={copyText('chrome.nav_account') ?? 'Account'}
        >
          <AccountIcon />
        </a>
      ) : null}
      <CartToggle cartUrl={cartUrl} hasCart={hasCart} />
      <HeaderMenuMobileToggle />
    </div>
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
