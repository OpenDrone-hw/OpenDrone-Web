import {ServerRouter} from 'react-router';
import {isbot} from 'isbot';
import {renderToReadableStream} from 'react-dom/server';
import {createContentSecurityPolicy} from '~/lib/csp';
import type {EntryContext} from 'react-router';
import type {AppLoadContext} from '~/lib/context';

// Minimal ambient declaration for Cloudflare Workers' HTMLRewriter, which
// Oxygen's edge runtime provides but isn't in the default TS lib and
// pulling the full @cloudflare/workers-types conflicts with Hydrogen's.
interface HRElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}
interface HRHandlers {
  element?: (element: HRElement) => void;
}
declare class HTMLRewriter {
  on(selector: string, handlers: HRHandlers): HTMLRewriter;
  transform(response: Response): Response;
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  context: AppLoadContext,
) {
  // cdn.shopify.com serves the product images (Shopify CDN URLs) and the
  // Hydrogen-era script defaults kept in app/lib/csp.ts.
  const {nonce, header, NonceProvider} = createContentSecurityPolicy({
    // Turnstile injects a script from challenges.cloudflare.com and renders
    // the challenge UI inside an iframe served from the same host. Without
    // these directives Hydrogen's default CSP drops both and the support
    // widget shows "Could not verify you are human".
    //
    // IMPORTANT: Hydrogen's createContentSecurityPolicy REPLACES each
    // directive with the list you pass - it does not merge. So we have
    // to include the Hydrogen defaults (`self`, the nonce placeholder,
    // cdn.shopify.com) explicitly, or the JS bundles served from that
    // CDN stop loading and the whole site stays in SSR-only mode.
    scriptSrc: [
      "'self'",
      'https://cdn.shopify.com',
      'https://challenges.cloudflare.com',
      // The hero 3D scene loads EXT_meshopt_compression GLBs; the meshopt
      // decoder instantiates a small WebAssembly module on the main thread.
      // 'wasm-unsafe-eval' allows WASM compilation ONLY - it does not permit
      // string eval()/new Function() - so it's the minimal grant needed.
      // Without it the decoder throws a CSP CompileError and the hero stays
      // blank. (Draco was rejected as an alternative: its decoder runs in a
      // blob: Worker, which worker-src also blocks.)
      "'wasm-unsafe-eval'",
    ],
    frameSrc: [
      "'self'",
      'https://challenges.cloudflare.com',
      // Official Discord server widget iframe used on /contact.
      // Server admin must enable widget in Server Settings → Widget.
      'https://discord.com',
      // YouTube build-video lightbox (WatchCard) - privacy-enhanced host.
      'https://www.youtube-nocookie.com',
    ],
    connectSrc: ["'self'", 'https://cdn.shopify.com', 'https://challenges.cloudflare.com'],
    // Support-thread attachments (images, video, audio) are hosted on
    // Discord's CDN. Without these the inline <img>/<video>/<audio> tags
    // in SupportThread fail to load because Hydrogen's default img-src /
    // media-src don't include the Discord hosts. cdn.discordapp.com is
    // the raw upload host; media.discordapp.net is the transcoded /
    // resized variant Discord rewrites large media to.
    imgSrc: [
      "'self'",
      'data:',
      'https://cdn.shopify.com',
      'https://cdn.discordapp.com',
      'https://media.discordapp.net',
      // YouTube thumbnail shown in the WatchCard build-video bubble.
      'https://i.ytimg.com',
      // Contributor avatars in the PDP contributors chapter.
      'https://avatars.githubusercontent.com',
    ],
    mediaSrc: [
      "'self'",
      'https://cdn.discordapp.com',
      'https://media.discordapp.net',
    ],
  });

  const body = await renderToReadableStream(
    <NonceProvider>
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
        nonce={nonce}
      />
    </NonceProvider>,
    {
      nonce,
      signal: request.signal,
      onError(error) {
        // Surface request context alongside the stack so the Oxygen
        // log line is enough to triage without cross-referencing CF
        // request IDs. Method + URL are usually all you need to know
        // which loader/action threw.
        const ray = request.headers.get('cf-ray') ?? null;
        console.error(
          '[ssr]',
          request.method,
          request.url,
          ray ? `cf-ray=${ray}` : '',
          error,
        );
        responseStatusCode = 500;
      },
    },
  );

  if (isbot(request.headers.get('user-agent'))) {
    await body.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');

  /**
   * Clickjacking defence: nothing may frame this site. Production keeps the
   * absolute form, `DENY` plus `frame-ancestors 'none'`.
   *
   * In dev only, that softens to same-origin. The studio at `/studio` previews
   * the real pages in an iframe, and self-framing is blocked by `'none'` just
   * as hard as a foreign site is. `'self'` still refuses every other origin, so
   * the dev machine is not meaningfully more exposed, and the production
   * headers are untouched: `process.env.NODE_ENV` is replaced at build time,
   * so the deployed worker hard-codes the strict branch with no runtime flag
   * that could be flipped by an environment variable. Same reasoning as
   * app/lib/turnstile.ts.
   */
  const isDev = process.env.NODE_ENV !== 'production';
  responseHeaders.set(
    'Content-Security-Policy',
    isDev ? header.replace("frame-ancestors 'none'", "frame-ancestors 'self'") : header,
  );
  responseHeaders.set('X-Frame-Options', isDev ? 'SAMEORIGIN' : 'DENY');
  responseHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  responseHeaders.set(
    'Permissions-Policy',
    'accelerometer=(), autoplay=(self "https://www.youtube-nocookie.com"), browsing-topics=(), camera=(), display-capture=(), fullscreen=(self "https://www.youtube-nocookie.com"), geolocation=(), gyroscope=(), hid=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(self), picture-in-picture=("https://www.youtube-nocookie.com"), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()',
  );
  responseHeaders.set('Cross-Origin-Resource-Policy', 'same-site');
  if (new URL(request.url).protocol === 'https:') {
    responseHeaders.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }
  responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');

  // Oxygen's asset CDN serves cross-origin module bundles (cdn.shopify.com),
  // and Chrome treats a <link rel="modulepreload"> without a crossorigin
  // attribute as credentialed - which the CDN rejects with 503 during the
  // window where a previous deployment's assets are being evicted. Force
  // crossorigin="anonymous" on every module script/preload so the preload
  // fetch matches the module fetch and the cached response is reused.
  const response = new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });

  return new HTMLRewriter()
    .on('link[rel="modulepreload"]', {
      element(el) {
        if (!el.getAttribute('crossorigin')) {
          el.setAttribute('crossorigin', 'anonymous');
        }
      },
    })
    .on('script[type="module"]', {
      element(el) {
        if (!el.getAttribute('crossorigin')) {
          el.setAttribute('crossorigin', 'anonymous');
        }
      },
    })
    .transform(response);
}
