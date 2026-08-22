import {useEffect} from 'react';
import {Analytics, getShopAnalytics, useNonce} from '@shopify/hydrogen';
import {
  Outlet,
  useRouteError,
  isRouteErrorResponse,
  type ShouldRevalidateFunction,
  Links,
  Meta,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteLoaderData,
} from 'react-router';
import type {Route} from './+types/root';
import favicon from '~/assets/favicon.svg';
import interVarWoff2 from '~/assets/fonts/inter-var.woff2';
import jetbrainsMonoWoff2 from '~/assets/fonts/jetbrains-mono-Regular.woff2';
import {HEADER_QUERY, HEADER_PRODUCTS_QUERY} from '~/lib/fragments';
import {resolveAllStatuses, roadmapStatusMap} from '~/lib/coming-soon';
import {fetchStatusFlagsFast} from '~/lib/roadmap-data';
import {CUSTOMER_NEWSLETTER_STATE_QUERY} from '~/graphql/customer-account/NewsletterStateQuery';
import resetStyles from '~/styles/reset.css?url';
import appStyles from '~/styles/app.css?url';
import {PageLayout} from './components/PageLayout';
import {SignalLost} from './components/SignalLost';
import {Txt} from './components/Txt';
import {copyText} from '~/lib/copy';
import {getCompanyIdentity} from '~/lib/company';
import {localeFromPathname, seoLocaleTag} from '~/lib/i18n';
import {buildOrgJsonLd, buildSeoMeta} from '~/lib/seo';
import {THEME_COLORS, THEME_INIT_SCRIPT} from '~/lib/theme';
import {themeOverrideCss} from '~/lib/theme-overrides';
import {installViewTransitionGuard} from '~/lib/view-transition';
import {captureAttribution} from '~/lib/growth/attribution';

export type RootLoader = typeof loader;

/**
 * Root meta — the fallback when no deeper route supplies meta, and the ONLY
 * meta that runs when an error renders root's ErrorBoundary (meta from
 * routes below the rendering boundary is discarded, which is why the 404
 * page used to ship an empty <title>). Healthy routes with their own meta
 * export override this wholesale (meta v2 semantics).
 */
export const meta: Route.MetaFunction = ({error}) => {
  if (!error) return buildSeoMeta({});
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return buildSeoMeta({
    title:
      status === 404
        ? (copyText('not-found.meta_title') ?? 'Signal lost')
        : (copyText('not-found.error_meta_title') ?? 'Something went wrong'),
    description:
      status === 404
        ? (copyText('not-found.meta_description') ??
          'This page does not exist. Return to home.')
        : (copyText('not-found.error_meta_description') ??
          'An unexpected error occurred.'),
    robots: 'noindex,nofollow',
  });
};

/**
 * This is important to avoid re-fetching root queries on sub-navigations
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  currentUrl,
  nextUrl,
}) => {
  // revalidate when a mutation is performed e.g add to cart, login...
  if (formMethod && formMethod !== 'GET') return true;

  // revalidate when manually revalidating via useRevalidator
  if (currentUrl.toString() === nextUrl.toString()) return true;

  // Defaulting to no revalidation for root loader data to improve performance.
  // When using this feature, you risk your UI getting out of sync with your server.
  // Use with caution. If you are uncomfortable with this optimization, update the
  // line below to `return defaultShouldRevalidate` instead.
  // For more details see: https://remix.run/docs/en/main/route/should-revalidate
  return false;
};

/**
 * The main and reset stylesheets are added in the Layout component
 * to prevent a bug in development HMR updates.
 *
 * This avoids the "failed to execute 'insertBefore' on 'Node'" error
 * that occurs after editing and navigating to another page.
 *
 * It's a temporary fix until the issue is resolved.
 * https://github.com/remix-run/remix/issues/9242
 */
export function links() {
  return [
    {rel: 'preconnect', href: 'https://cdn.shopify.com'},
    {rel: 'preconnect', href: 'https://shop.app'},
    // Preload the above-the-fold typefaces so first paint doesn't flash
    // system fallbacks then reflow on swap. Fonts fetch in CORS mode even
    // same-origin, so crossorigin is required for the preload to match the
    // @font-face request and not double-download. The hrefs are the Vite
    // asset imports, not /fonts/ paths: app.css is served from the CDN and
    // resolves its url() against that origin, so only an identical hashed
    // URL on both sides makes the preload actually satisfy the font request.
    // - Inter: body text.
    // - JetBrains Mono: NOT just spec tables — it renders the header nav,
    //   prices and SKUs sitewide, all above the fold.
    {
      rel: 'preload',
      href: interVarWoff2,
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    },
    {
      rel: 'preload',
      href: jetbrainsMonoWoff2,
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    },
    {rel: 'icon', type: 'image/svg+xml', href: favicon},
    // PNG fallbacks for browsers that ignore SVG favicons, iOS home-screen,
    // and PWA install. Files live in /public (served from the site root).
    {rel: 'apple-touch-icon', href: '/apple-touch-icon.png'},
    {rel: 'manifest', href: '/manifest.json'},
  ];
}

export async function loader(args: Route.LoaderArgs) {
  // Start fetching non-critical data without blocking time to first byte
  const deferredData = loadDeferredData(args);

  // Await the critical data required to render initial state of the page
  const criticalData = await loadCriticalData(args);

  const {storefront, env} = args.context;

  const company = getCompanyIdentity(env as unknown as Record<string, string | undefined>);

  // Derive locale from the URL path so /nl/* actually renders <html lang="nl">.
  // Hydrogen's storefront.i18n is pinned to EN/US in app/lib/context.ts and
  // doesn't follow the URL; using it would force every page to en_US.
  const urlLocale = localeFromPathname(new URL(args.request.url).pathname);
  const locale = urlLocale ? seoLocaleTag(urlLocale) : 'en_US';

  // Live roadmap statuses (GitHub status-* topics over the static list),
  // resolved once here so every card, buy module and feed sees the same
  // answer. 400ms cap: cache warm resolves instantly, cache cold falls back
  // to the static statuses while the fetch fills the cache for the next
  // request.
  const globalComingSoon = env.PUBLIC_COMING_SOON !== '0';
  const statusFlags = await fetchStatusFlagsFast(
    env.GITHUB_STATUS_TOKEN,
    400,
    args.context.waitUntil,
  );

  return {
    ...deferredData,
    ...criticalData,
    publicStoreDomain: env.PUBLIC_STORE_DOMAIN,
    company,
    locale,
    // Pre-launch banner kill switch: defaults ON; set PUBLIC_PRELAUNCH=0 in
    // Oxygen the day orders open.
    prelaunch: env.PUBLIC_PRELAUNCH !== '0',
    // Coming-soon kill switch: defaults ON; set PUBLIC_COMING_SOON=0 the day
    // orders open. Per-product overrides in product-content.ts win over this.
    comingSoon: globalComingSoon,
    // Per-handle tri-state resolved with the live topic flags; the
    // useProductStatus/useComingSoon hooks read this map first.
    productStatuses: resolveAllStatuses(globalComingSoon, statusFlags),
    // The five-stage roadmap word per handle, for status chips on cards
    // and listings (display vocabulary; buyability is the map above).
    roadmapStatuses: roadmapStatusMap(statusFlags),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
    shop: getShopAnalytics({
      storefront,
      publicStorefrontId: env.PUBLIC_STOREFRONT_ID,
    }),
    consent: {
      // checkoutDomain is required by Hydrogen Analytics. Fall back to the
      // store domain when the dedicated checkout subdomain isn't configured.
      checkoutDomain:
        env.PUBLIC_CHECKOUT_DOMAIN || env.PUBLIC_STORE_DOMAIN,
      storefrontAccessToken: env.PUBLIC_STOREFRONT_API_TOKEN,
      // No cookie banner at launch: Plausible-only analytics, Shopify analytics
      // not shipped. Consent is default-denied. Banner will return when marketing
      // cookies are introduced.
      withPrivacyBanner: false,
      country: args.context.storefront.i18n.country,
      language: args.context.storefront.i18n.language,
    },
  };
}

/**
 * Load data necessary for rendering content above the fold. This is the critical data
 * needed to render the page. If it's unavailable, the whole page should 400 or 500 error.
 */
async function loadCriticalData({context}: Route.LoaderArgs) {
  const {storefront} = context;

  const [header] = await Promise.all([
    storefront.query(HEADER_QUERY, {
      cache: storefront.CacheLong(),
      variables: {
        headerMenuHandle: 'main-menu', // Adjust to your header menu handle
      },
    }),
    // Add other queries here, so that they are loaded in parallel
  ]);

  return {header};
}

/**
 * Load data for rendering content below the fold. This data is deferred and will be
 * fetched after the initial page load. If it's unavailable, the page should still 200.
 * Make sure to not throw any errors here, as it will cause the page to 500.
 */
function loadDeferredData({context}: Route.LoaderArgs) {
  const {customerAccount, cart, storefront} = context;

  const isLoggedIn = customerAccount.isLoggedIn();

  // Marketing-consent state for the signed-in customer so the footer newsletter
  // can be subscription-aware (no re-asking a subscribed user for their email).
  // Deferred + best-effort: resolves to null for guests or on any error.
  const newsletterAccount = isLoggedIn
    .then(async (loggedIn) => {
      if (!loggedIn) return null;
      const {data} = await customerAccount.query(
        CUSTOMER_NEWSLETTER_STATE_QUERY,
      );
      const email = data?.customer?.emailAddress;
      if (!email?.emailAddress) return null;
      return {
        email: email.emailAddress,
        subscribed: email.marketingState === 'SUBSCRIBED',
      };
    })
    .catch(() => null);

  // NOTE: the Shopify "footer" menu is deliberately not fetched — Footer.tsx
  // renders hardcoded link arrays. The old deferred FOOTER_QUERY was a dead
  // Storefront API round-trip on every session.
  return {
    cart: cart.get(),
    isLoggedIn,
    newsletterAccount,
    // Deferred so it never blocks TTFB; feeds the header family dropdowns.
    // Best-effort: a failure resolves to [] so the header still renders.
    familyProducts: storefront
      .query(HEADER_PRODUCTS_QUERY, {cache: storefront.CacheLong()})
      .then((d) => d?.products?.nodes ?? [])
      .catch(() => []),
  };
}

export function Layout({children}: {children?: React.ReactNode}) {
  const nonce = useNonce();
  const data = useRouteLoaderData<RootLoader>('root');
  const htmlLang = (data?.locale || 'en_US').split('_')[0] || 'en';
  const orgJsonLd = data?.company ? buildOrgJsonLd(data.company) : null;
  const themeCss = themeOverrideCss();

  // Make every view transition resilient: route React Router's navigation
  // transitions (and the manual theme-toggle reveal) through one guard that
  // tracks the in-flight transition and swallows AbortError/InvalidStateError
  // when one is skipped/interrupted. Without this, overlapping transitions
  // threw `InvalidStateError: Transition was aborted because of invalid state`
  // and could leave a route half-rendered (the PDP board stuck pre-reveal).
  // Idempotent + client-only.
  useEffect(() => {
    installViewTransitionGuard();
  }, []);

  // First-touch channel attribution: stash utm_*/ref params from the
  // landing URL in sessionStorage (session-scoped by design — see
  // app/lib/growth/attribution.ts for the ePrivacy rationale). Runs once
  // on hydration; later client-side navigations can't be a first touch.
  useEffect(() => {
    captureAttribution();
  }, []);

  return (
    <html lang={htmlLang} className="dark" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width,initial-scale=1,viewport-fit=cover"
        />
        <meta name="theme-color" content={THEME_COLORS.dark} />
        {/* Resolve + apply the theme before first paint so a light-mode
            visitor never sees a dark flash. Must run before the stylesheet
            and before hydration; nonce satisfies CSP. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{__html: THEME_INIT_SCRIPT}}
        />
        {/* Pre-paint blanket for the reading cascade: injected BY script,
            so its very existence is the js-gate — a no-JS reader never gets
            it and sees the whole page. Hides everything below the first
            chapter from the first frame (no flash of content that then
            vanishes and re-reveals); EditorialShell lifts it by adding
            .cascade-armed the moment the per-element reveal system is
            armed. Inline in head so it runs before first paint; hydration
            wiped class/attribute markers off <html>, which is why this is
            a style node and not a selector gate. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "var s=document.createElement('style');s.textContent='@media (prefers-reduced-motion: no-preference){.editorial-shell:not(.cascade-armed) .editorial-section:not(:first-of-type)>*,.editorial-shell:not(.cascade-armed) .editorial-cta>*{visibility:hidden}}';document.head.appendChild(s)",
          }}
        />
        {/* Pause all CSS animations while the window is unfocused or the tab is
            hidden — the ambient infinite animations (wordmark sheen, banner
            ping, etc.) otherwise keep the GPU compositing every frame even when
            no one is looking. Full fidelity returns the instant the window is
            focused. Inline + pre-paint so it's active before first frame. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var r=document.documentElement,t,idle=false;function paused(){return document.hidden||!document.hasFocus()||idle;}function u(){r.classList.toggle('anim-paused',paused());}function active(){idle=false;u();clearTimeout(t);t=setTimeout(function(){idle=true;u();},4000);}addEventListener('focus',active);addEventListener('blur',u);document.addEventListener('visibilitychange',u);['pointermove','pointerdown','keydown','wheel','scroll'].forEach(function(e){addEventListener(e,active,{passive:true});});active();})();",
          }}
        />
        {/* Jank governor: sample frame times in ~90-frame windows; after two
            consecutive janky windows add `perf-lite` (pauses the ambient
            infinite animations + strips live rail blurs via the same CSS as
            anim-paused), and — unlike the removed perf-tier system — RELEASE
            it again after two clean windows. Sampling is suspended while
            `anim-paused` is freezing the workload (idle/unfocused), so the
            governor never releases perf-lite off artificially clean idle
            frames and oscillates. No device classification, no React
            context: one <html> class, decorative effects only. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "(function(){var r=document.documentElement,last=0,jank=0,total=0,bad=0,good=0,lite=false;var JANK=34,WIN=90,BAD=0.4,GOOD=0.15;function tick(ts){var paused=r.classList.contains('anim-paused');if(!document.hidden&&document.hasFocus()&&!paused){if(last){var d=ts-last;total++;if(d>JANK)jank++;}last=ts;if(total>=WIN){var f=jank/total;jank=0;total=0;if(f>BAD){good=0;if(++bad>=2&&!lite){lite=true;r.classList.add('perf-lite');}}else if(f<GOOD){bad=0;if(++good>=2&&lite){lite=false;r.classList.remove('perf-lite');}}else{bad=0;good=0;}}}else{last=0;jank=0;total=0;}requestAnimationFrame(tick);}requestAnimationFrame(tick);})();",
          }}
        />
        <link rel="stylesheet" href={resetStyles}></link>
        <link rel="stylesheet" href={appStyles}></link>
        {/* Design-token overrides authored in the studio (content/theme.json).
            After the stylesheet so it wins on order, before <Meta/> so route
            styles can still override it. Empty string when nothing is
            overridden, which is the normal state. */}
        {themeCss ? (
          <style
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{__html: themeCss}}
          />
        ) : null}
        <Meta />
        <Links />
        {/* Plausible — cookieless analytics, no consent required.
            Combined legacy-script variant: `tagged-events` enables custom
            events with props, `revenue` attaches monetary values to them
            (verified served 2026-07-06; extensions compose as
            script.<ext1>.<ext2>.js). Manual events go through the
            trackEvent() helper in app/lib/growth/plausible.ts, which
            installs the window.plausible queue stub so events fired before
            this deferred script loads are replayed on init.
            suppressHydrationWarning: nonce is per-request and only meaningful
            server-side; the client-side value is empty, which React would
            otherwise flag as a hydration mismatch. */}
        <script
          defer
          data-domain="opendrone.be"
          src="https://plausible.io/js/script.tagged-events.revenue.js"
          nonce={nonce}
          suppressHydrationWarning
        />
        {orgJsonLd ? (
          <script
            type="application/ld+json"
            nonce={nonce}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{__html: JSON.stringify(orgJsonLd)}}
          />
        ) : null}
      </head>
      <body className="bg-[var(--color-bg)] text-[var(--color-text)] min-h-screen flex flex-col">
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  const data = useRouteLoaderData<RootLoader>('root');
  const {pathname} = useLocation();

  // The studio owns the whole viewport and must not be wrapped in the site's
  // header, footer or analytics: it is a tool, not a page. `import.meta.env.DEV`
  // is statically false in a production build, so this test and everything it
  // guards folds away, matching the route-level exclusion in app/routes.ts.
  if (import.meta.env.DEV && pathname.startsWith('/studio')) {
    return <Outlet />;
  }

  if (!data) {
    return <Outlet />;
  }

  return (
    <Analytics.Provider
      cart={data.cart}
      shop={data.shop}
      consent={data.consent}
    >
      <PageLayout {...data}>
        <Outlet />
      </PageLayout>
    </Analytics.Provider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  let errorMessage = '';
  let errorStatus = 500;

  if (isRouteErrorResponse(error)) {
    errorMessage =
      typeof error.data === 'string' ? error.data : (error.data?.message ?? '');
    errorStatus = error.status;
  } else if (error instanceof Error) {
    errorMessage = error.message;
  }

  const isNotFound = errorStatus === 404;

  // 404 gets the easter egg: an FPV "lost signal / failsafe" screen.
  if (isNotFound) {
    return <SignalLost />;
  }

  return (
    <div className="route-error page-shell">
      <p className="route-error-status">{errorStatus}</p>
      <Txt id="not-found.error_title" as="h1" className="route-error-title" />
      <Txt id="not-found.error_body" as="p" className="route-error-body" />
      {errorMessage ? (
        <details className="route-error-details">
          <summary>
            <Txt id="not-found.error_details" />
          </summary>
          <pre>{errorMessage}</pre>
        </details>
      ) : null}
      <div className="route-error-actions">
        <a href="/" className="hero-cta-primary">
          <Txt id="not-found.error_cta_home" />
        </a>
        <a href="/collections/all" className="hero-cta-secondary">
          <Txt id="not-found.error_cta_shop" />
        </a>
      </div>
    </div>
  );
}
