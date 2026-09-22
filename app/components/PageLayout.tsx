import {BackgroundWarmup} from '~/components/BackgroundWarmup';
import {useLocation} from 'react-router';
import {MotionConfig} from 'motion/react';
import type {CompanyIdentity} from '~/lib/company';
import {Aside} from '~/components/Aside';
import {Footer} from '~/components/Footer';
import {Header, HeaderMenu, type HeaderFamilyProduct} from '~/components/Header';
import {LangToggle, LegalLanguages} from '~/components/LangToggle';
import {isLegalPath} from '~/lib/i18n';
import {PlaceholderBanner} from '~/components/PlaceholderBanner';
import {RouteProgress} from '~/components/RouteProgress';
import {Txt} from '~/components/Txt';
import {CartAddedDialog} from '~/components/CartAddedDialog';
import type {CommerceHandoff} from '~/lib/shop-links';

interface PageLayoutProps {
  commerceHandoff: CommerceHandoff;
  accountUrl: string | null;
  company: CompanyIdentity;
  turnstileSiteKey?: string | null;
  /** Both commerce gates are open (root loader). */
  shopOpen?: boolean;
  /** The shop is not open yet: shows the "Opening soon" pill. Derived from
   *  the same gates as `shopOpen` in the root loader. */
  prelaunch?: boolean;
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
  prelaunch = true,
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
        <BackgroundWarmup />
        <div className={isHomepage ? 'homepage-layout' : ''}>
          <a className="skip-link" href="#main-content">
            <Txt id="chrome.skip_link" />
          </a>
          <RouteProgress />
          {/* On PDPs the bottom-right corner belongs to the buy rail's
              notify-at-launch form (consent checkbox + Privacy link at
              common scroll positions) - park the pill bottom-left there. */}
          {prelaunch && !shopOpen && (
            <PlaceholderBanner
              side={pathname.startsWith('/products/') ? 'left' : 'right'}
            />
          )}
          <Header
            commerceHandoff={commerceHandoff}
            accountUrl={accountUrl}
            familyProducts={familyProducts}
            shopOpen={shopOpen}
          />
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
              company={company}
              turnstileSiteKey={turnstileSiteKey ?? null}
            />
          ) : (
            <div className="home-mobile-footer">
              <Footer
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

function MobileMenuAside({accountUrl}: {accountUrl: string | null}) {
  const {pathname} = useLocation();
  return (
    <Aside type="mobile" heading={<Txt id="chrome.aside_menu_heading" />}>
      <HeaderMenu viewport="mobile" accountUrl={accountUrl} />
      {/* Language switch lives in the drawer on phones - it's hidden from the
          top bar there to keep the header row inside a 320px viewport.
          On shop pages the drawer says in words that the shop is English
          and links the legal texts in each language instead. */}
      <LangToggle className="mobile-menu-lang" shopPages={false} />
      {isLegalPath(pathname) ? null : (
        <LegalLanguages className="mt-3 shrink-0 text-[12px] leading-relaxed text-[var(--color-text-muted)]" />
      )}
    </Aside>
  );
}
