import {useLocation} from 'react-router';
import {MotionConfig} from 'motion/react';
import type {CompanyIdentity} from '~/lib/company';
import {Aside} from '~/components/Aside';
import {Footer} from '~/components/Footer';
import {Header, HeaderMenu, type HeaderFamilyProduct} from '~/components/Header';
import {LangToggle} from '~/components/LangToggle';
import {RegionSwitch} from '~/components/RegionSwitch';
import {ThemeToggle} from '~/components/ThemeToggle';
import {RouteProgress} from '~/components/RouteProgress';
import {Txt} from '~/components/Txt';
import {CartAddedDialog} from '~/components/CartAddedDialog';
import {ChatFpvMenuEntry} from '~/components/ChatFpvEntry';
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
      <HeaderMenu accountUrl={accountUrl} />
      {/* Settings the phone bar leaves out: region and currency (nothing
          while US sales are closed), the theme, and the legal-page language.
          LangToggle self-hides on non-legal routes. */}
      <div className="mobile-menu-settings">
        <RegionSwitch className="mobile-menu-region" />
        <ThemeToggle showLabel className="mobile-menu-theme" />
        <LangToggle className="mobile-menu-lang" />
      </div>
      <ChatFpvMenuEntry />
    </Aside>
  );
}
