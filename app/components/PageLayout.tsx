import {useLocation} from 'react-router';
import {MotionConfig} from 'motion/react';
import type {CompanyIdentity} from '~/lib/company';
import {Aside} from '~/components/Aside';
import {Footer} from '~/components/Footer';
import {Header, HeaderMenu, type HeaderFamilyProduct} from '~/components/Header';
import {LangToggle} from '~/components/LangToggle';
import {PlaceholderBanner} from '~/components/PlaceholderBanner';
import {RouteProgress} from '~/components/RouteProgress';
import {Txt} from '~/components/Txt';

interface PageLayoutProps {
  shopUrl: string;
  company: CompanyIdentity;
  turnstileSiteKey?: string | null;
  prelaunch?: boolean;
  familyProducts?: HeaderFamilyProduct[];
  children?: React.ReactNode;
}

export function PageLayout({
  children = null,
  shopUrl,
  company,
  turnstileSiteKey,
  prelaunch = true,
  familyProducts,
}: PageLayoutProps) {
  const {pathname} = useLocation();
  const isHomepage = pathname === '/';

  return (
    <MotionConfig reducedMotion="user">
      <Aside.Provider>
        {/* The cart aside is gone with the local cart: the cart icon links
            to the shop (contract section 1.3). The mobile menu drawer is
            the only aside left. */}
        <MobileMenuAside shopUrl={shopUrl} />
        <div className={isHomepage ? 'homepage-layout' : ''}>
          <a className="skip-link" href="#main-content">
            <Txt id="chrome.skip_link" />
          </a>
          <RouteProgress />
          {/* On PDPs the bottom-right corner belongs to the buy rail's
              notify-at-launch form (consent checkbox + Privacy link at
              common scroll positions) - park the pill bottom-left there. */}
          {prelaunch && (
            <PlaceholderBanner
              side={pathname.startsWith('/products/') ? 'left' : 'right'}
            />
          )}
          <Header shopUrl={shopUrl} familyProducts={familyProducts} />
          <main id="main-content" className="site-main">
            {children}
          </main>
          {/* The desktop homepage is the scroll-pinned WebGL hero and owns its
              own ending, so it ships no footer. The mobile homepage (MobileHome)
              is an ordinary scrolling page - without a footer it ends in a void
              with no nav/legal/newsletter. Render the footer there too, hidden
              above the mobile breakpoint so the desktop hero is untouched. */}
          {!isHomepage ? (
            <Footer
              shopUrl={shopUrl}
              company={company}
              turnstileSiteKey={turnstileSiteKey ?? null}
            />
          ) : (
            <div className="home-mobile-footer">
              <Footer
                shopUrl={shopUrl}
                company={company}
                turnstileSiteKey={turnstileSiteKey ?? null}
              />
            </div>
          )}
        </div>
      </Aside.Provider>
    </MotionConfig>
  );
}

function MobileMenuAside({shopUrl}: {shopUrl: string}) {
  return (
    <Aside type="mobile" heading={<Txt id="chrome.aside_menu_heading" />}>
      <HeaderMenu viewport="mobile" shopUrl={shopUrl} />
      {/* Language switch lives in the drawer on phones - it's hidden from the
          top bar there to keep the header row inside a 320px viewport.
          LangToggle self-hides on non-legal routes. */}
      <LangToggle className="mobile-menu-lang" />
    </Aside>
  );
}
