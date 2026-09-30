import {useLocation} from 'react-router';
import {MotionConfig} from 'motion/react';
import type {CompanyIdentity} from '~/lib/company';
import {Aside} from '~/components/Aside';
import {Footer} from '~/components/Footer';
import {Header, HeaderMenu, type HeaderFamilyProduct} from '~/components/Header';
import {LangToggle} from '~/components/LangToggle';
import {RegionSwitch} from '~/components/RegionSwitch';
import {RouteProgress} from '~/components/RouteProgress';
import {Txt} from '~/components/Txt';
import {CartAddedDialog} from '~/components/CartAddedDialog';
import {ChatFpvMenuEntry} from '~/components/ChatFpvEntry';
import {LegalGuaranteeNotice} from '~/components/LegalGuaranteeNotice';
import type {CommerceHandoff} from '~/lib/shop-links';

interface PageLayoutProps {
  commerceHandoff: CommerceHandoff;
  accountUrl: string | null;
  company: CompanyIdentity;
  turnstileSiteKey?: string | null;
  /** Both commerce gates are open (root loader). */
  shopOpen?: boolean;
  familyProducts?: HeaderFamilyProduct[];
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
}: PageLayoutProps) {
  const {pathname} = useLocation();
  const isHomepage = pathname === '/';

  return (
    <MotionConfig reducedMotion="user">
      <Aside.Provider>
        {/* The mobile menu drawer is the only aside; the add-to-cart dialog
            is its own overlay, opened by every AddToCartButton. */}
        <MobileMenuAside accountUrl={accountUrl} />
        <CartAddedDialog />
        <div className={isHomepage ? 'homepage-layout' : ''}>
          <a className="skip-link" href="#main-content">
            <Txt id="chrome.skip_link" />
          </a>
          <RouteProgress />
          <Header
            commerceHandoff={commerceHandoff}
            accountUrl={accountUrl}
            familyProducts={familyProducts}
            shopOpen={shopOpen}
          />
          <main id="main-content" className="site-main">
            <LegalGuaranteeNotice isHomepage={isHomepage} />
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
