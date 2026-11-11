import {useEffect} from 'react';
import {useLocation, useRouteLoaderData} from 'react-router';
import {MotionConfig} from 'motion/react';
import type {CompanyIdentity} from '~/lib/company';
import {Aside} from '~/components/Aside';
import {Footer} from '~/components/Footer';
import {Header, HeaderMenu, type HeaderFamilyProduct} from '~/components/Header';
import {LangToggle} from '~/components/LangToggle';
import {RegionSwitch} from '~/components/RegionSwitch';
import {RouteProgress} from '~/components/RouteProgress';
import {RouteAnnouncer} from '~/components/RouteAnnouncer';
import {Txt} from '~/components/Txt';
import {CartAddedDialog} from '~/components/CartAddedDialog';
import {LocationNotice} from '~/components/LocationNotice';
import {ChatFpvMenuEntry} from '~/components/ChatFpvEntry';
import type {CommerceHandoff} from '~/lib/shop-links';
import {AvailabilityBar} from '~/components/AvailabilityBanner';
import {notSoldNote} from '~/components/AddToCartButton';
import {useShipGeo} from '~/components/ShipChip';
import {reconcilePendingShipTo} from '~/lib/pending-ship-to';
import {availabilityBannerHiddenOn, type GeoAvailabilityRegion} from '~/lib/geo-availability';
import type {Locale} from '~/lib/i18n';

interface PageLayoutProps {
  commerceHandoff: CommerceHandoff;
  accountUrl: string | null;
  company: CompanyIdentity;
  turnstileSiteKey?: string | null;
  /** Both commerce gates are open (root loader). */
  shopOpen?: boolean;
  familyProducts?: HeaderFamilyProduct[];
  /** The visitor's batch region and language (root loader), for the availability card. */
  geo?: {region: GeoAvailabilityRegion; locale: Locale};
  children?: React.ReactNode;
}

export function PageLayout({
  children = null,
  commerceHandoff,
  accountUrl,
  company,
  turnstileSiteKey,
  shopOpen = false,
  familyProducts,
  geo,
}: PageLayoutProps) {
  const {pathname} = useLocation();
  const isHomepage = pathname === '/';
  // The bar follows a Ship to switch at once (lib/pending-ship-to.ts); the
  // pending country clears when the root loader returns new data.
  const shipGeo = useShipGeo();
  const rootData = useRouteLoaderData('root');
  useEffect(() => reconcilePendingShipTo(rootData), [rootData]);

  return (
    <MotionConfig reducedMotion="user">
      <Aside.Provider>
        {/* The mobile menu drawer is the only aside; the add-to-cart dialog
            is its own overlay, opened by every AddToCartButton. */}
        <MobileMenuAside accountUrl={accountUrl} />
        <CartAddedDialog />
        {/* The ship time for a new destination, once per change: a fixed
            toast, out of the flow, filled from an effect (no CLS, no
            hydration mismatch). Only while ordering is open, as the bar. */}
        {shopOpen ? <LocationNotice /> : null}
        <div
          className={isHomepage ? 'site-layout homepage-layout' : 'site-layout'}
        >
          <a className="skip-link" href="#main-content">
            <Txt id="chrome.skip_link" />
          </a>
          <RouteProgress />
          <RouteAnnouncer />
          {/* Ordering is open: the batch line for the visitor's country, a bar at the very top (under the
              staging strip on staging). Never on /flash or /guides/*. */}
          {shopOpen && !availabilityBannerHiddenOn(pathname) ? <AvailabilityBar
              geo={shipGeo ?? geo}
              ordinary={Boolean((rootData as {ordinaryShop?: boolean} | undefined)?.ordinaryShop)}
              // A country the shop cannot sell to reads the buy box's own words, never a ship date.
              note={(shipGeo ?? geo)?.region === 'us' ? null : notSoldNote(((shipGeo ?? geo) as {country?: string | null} | null | undefined)?.country ?? null, (rootData as {usShippingRate?: number} | undefined)?.usShippingRate ?? null)}
            /> : null}
          <Header
            commerceHandoff={commerceHandoff}
            accountUrl={accountUrl}
            familyProducts={familyProducts}
            shopOpen={shopOpen}
          />
          <main id="main-content" className="site-main">
            {/* The card in the flow, all widths; the phone homepage places it under its hero instead. */}
            {children}
          </main>
          {/* The home scene is one pinned viewport; the footer sits under it,
              reached when the walkthrough hands the page back at its last
              beat (desktop) or by plain scroll (phone). */}
          <Footer
            company={company}
            turnstileSiteKey={turnstileSiteKey ?? null}
          />
        </div>
      </Aside.Provider>
    </MotionConfig>
  );
}

function MobileMenuAside({accountUrl}: {accountUrl: string | null}) {
  return (
    <Aside type="mobile" heading={<Txt id="chrome.aside_menu_heading" />}>
      {/* Region switch: hidden from the phone top bar (a 320px row), rendered
          here at full tap size, first so it never scrolls out of the drawer.
          Nothing while US sales are closed. */}
      <RegionSwitch className="mobile-menu-region" />
      <HeaderMenu viewport="mobile" accountUrl={accountUrl} />
      {/* Language switch lives in the drawer on phones - it's hidden from the
          top bar there to keep the header row inside a 320px viewport.
          LangToggle self-hides on non-legal routes. */}
      <LangToggle className="mobile-menu-lang" />
      <ChatFpvMenuEntry />
    </Aside>
  );
}
