/// <reference types="vite/client" />
/// <reference types="react-router" />

// Enhance TypeScript's built-in typings.
import '@total-typescript/ts-reset';

// Extend the Worker Env interface with project env vars so context.env.* is
// strongly typed in routes.
declare global {
  // Build stamp from vite.config.ts `define`: short commit hash ('' when the
  // build had no git) and ISO build date.
  const __BUILD_REV__: string;
  const __BUILD_DATE__: string;

  // The Workers runtime types are declared minimally here, only for what
  // the app uses. The full @cloudflare/workers-types package redeclares DOM
  // globals such as Element with Workers-only signatures, which breaks
  // browser code type-checked in the same program.
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  // Minimal KVNamespace shape. Only the methods we actually call are
  // declared.
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(
      key: string,
      value: string,
      options?: {expirationTtl?: number; expiration?: number; metadata?: unknown},
    ): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: {prefix?: string; limit?: number; cursor?: string}): Promise<{
      keys: Array<{name: string; expiration?: number; metadata?: unknown}>;
      list_complete: boolean;
      cursor?: string;
    }>;
  }

  // Minimal D1 shape (the support ticket store, `SUPPORT_DB`). Only the
  // calls app/lib/support/store.ts makes are declared.
  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    meta: {changes?: number; last_row_id?: number};
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run(): Promise<D1Result>;
  }
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  }

  // Minimal R2 shape (the ticket attachment bucket, `SUPPORT_FILES`).
  interface R2ObjectBody {
    body: ReadableStream;
    size: number;
    httpMetadata?: {contentType?: string};
  }
  interface R2Bucket {
    put(key: string, value: ArrayBuffer | Uint8Array, options?: {httpMetadata?: {contentType?: string}}): Promise<unknown>;
    get(key: string): Promise<R2ObjectBody | null>;
    delete(keys: string | string[]): Promise<void>;
    list(options?: {prefix?: string; limit?: number; cursor?: string}): Promise<{objects: Array<{key: string}>; truncated: boolean; cursor?: string}>;
  }

  // Cloudflare Workers Rate Limiting binding (wrangler.toml
  // `[[ratelimits]]`), declared minimally like KVNamespace above.
  interface RateLimit {
    limit(options: {key: string}): Promise<{success: boolean}>;
  }

  interface Env {
    // Signs the locale and cart session cookies.
    SESSION_SECRET: string;

    // The app as the commerce backend (/shop routes, app/lib/commerce/app-api.ts). Every /shop route answers 404
    // unless COMMERCE_SOURCE is exactly 'app'. Neither wrangler file sets it; the founder turns it on in a test
    // environment first. APP_API_URL: the app origin; APP_ACCESS_CLIENT_ID and APP_ACCESS_CLIENT_SECRET: the
    // Cloudflare Access service token; APP_STOREFRONT_TOKEN: the app's storefront service bearer; APP_PROJECT:
    // the project id whose catalog and posts this site shows.
    COMMERCE_SOURCE?: string;
    APP_API_URL?: string;
    APP_ACCESS_CLIENT_ID?: string;
    APP_ACCESS_CLIENT_SECRET?: string;
    APP_STOREFRONT_TOKEN?: string;
    APP_PROJECT?: string;
    // The public path the app's copied shop images are served at (app mode); the app's [commerce] media_path is the
    // same value. Default /shop-media (app/lib/commerce/app-media.ts).
    // Sites from the app (app/lib/site): with SITE_SOURCE exactly 'app' and APP_API_URL set, the request hostname picks the
    // site (storefront.site, storefront.page: theme, menus, SEO, Plausible domain, pages) and an unknown host answers 404.
    // Off by default; no wrangler file sets it. Uses the same APP_* credentials as COMMERCE_SOURCE.
    SITE_SOURCE?: string;
    // Studio preview bridge (app/lib/site/preview-bridge.ts): with SITE_PREVIEW exactly '1' and STUDIO_ORIGIN (e.g.
    // https://app.incutec.com) every text carries data-edit, a click posts it to the Studio frame and the Studio can set
    // texts live. Staging only; never set on production.
    SITE_PREVIEW?: string;
    STUDIO_ORIGIN?: string;
    APP_MEDIA_PATH?: string;
    // Payment webhook relay (app/lib/commerce/pay-webhook.ts, POST /api/pay/webhook/:provider, app mode only).
    // STRIPE_WEBHOOK_SECRET: the endpoint signing secret (whsec_...). PAYPAL_WEBHOOK_ID_LIVE / _SANDBOX: the id of the
    // webhook on that REST app; PAYPAL_CLIENT_ID_* and PAYPAL_CLIENT_SECRET_* of the same app let the Worker call
    // PayPal's verify-webhook-signature API. All Worker secrets. Mollie has no secret: only an id is relayed.
    STRIPE_WEBHOOK_SECRET?: string;
    PAYPAL_WEBHOOK_ID_LIVE?: string;
    PAYPAL_CLIENT_ID_LIVE?: string;
    PAYPAL_CLIENT_SECRET_LIVE?: string;
    PAYPAL_WEBHOOK_ID_SANDBOX?: string;
    PAYPAL_CLIENT_ID_SANDBOX?: string;
    PAYPAL_CLIENT_SECRET_SANDBOX?: string;
    // Checkout address suggestions (app/lib/commerce/address-provider.ts): 'photon' (keyless, OpenStreetMap) or
    // 'geoapify' (needs GEOAPIFY_API_KEY, a Worker secret). Unset: no suggestions.
    ADDRESS_PROVIDER?: string;
    GEOAPIFY_API_KEY?: string;
    // Express wallet buttons (app/lib/commerce/payment-provider.ts): 'stripe' with STRIPE_PUBLISHABLE_KEY. Unset: none.
    EXPRESS_PAY_PROVIDER?: string;
    STRIPE_PUBLISHABLE_KEY?: string;
    // Text of a slim banner above every page (a test shop: "TEST SHOP: no real payments"). Unset: no banner.
    TEST_BANNER?: string;

    // Checkout mutation gate. The catalog stays read-only unless this is
    // exactly '1'. Production and staging set it in their wrangler [vars].
    SHOPIFY_CHECKOUT_WRITE_ENABLED?: string;
    SHOPIFY_STORE_DOMAIN?: string;
    // '1' mails /wholesale applications to the company inbox through Resend.
    TRADE_MAIL_ENABLED?: string;
    SHOPIFY_STOREFRONT_TOKEN?: string;
    SHOPIFY_STOREFRONT_API_VERSION?: string;
    SHOPIFY_CHECKOUT_DOMAIN?: string;
    // Exact account destination copied from Shopify's customer-account
    // configuration. No account subpaths are derived locally.
    SHOPIFY_CUSTOMER_ACCOUNT_URL?: string;
    SHOPIFY_NEWSLETTER_WRITE_ENABLED?: string;
    SHOPIFY_ADMIN_API_TOKEN?: string;
    SHOPIFY_ADMIN_API_VERSION?: string;
    SHOPIFY_PRICES_INCLUDE_VAT?: string;
    // Writes each preorder price step to Shopify (app/lib/shopify-price-tier.ts),
    // from the orders/paid webhook and the scheduled reconcile. Anything but
    // '1' leaves Shopify's prices alone and campaign SKUs whose price is
    // under their step close instead.
    SHOPIFY_PRICE_TIER_WRITE_ENABLED?: string;
    // Shopify webhook signing secret, for the orders/paid HMAC: the client
    // secret of the app that registers the webhook (OpenDrone Infra).
    // Without it the webhook route refuses every request. A Worker secret.
    SHOPIFY_WEBHOOK_SECRET?: string;
    // 1 sends a Plausible `Purchase` event (revenue, source, ref) from the
    // orders/paid webhook, forwarding the buyer's browser IP and
    // User-Agent from the order (app/lib/growth/plausible-server.ts).
    // Anything else sends nothing.
    PLAUSIBLE_PURCHASE_EVENTS_ENABLED?: string;
    // Staging gate: when set, the Worker asks for HTTP basic auth as
    // "opendrone" with this password before serving anything. Production
    // leaves it unset.
    STAGING_PASSWORD?: string;
    // "0" turns off the preorder fulfillment holds and batch tags (webhook
    // and cron). Unset or anything else leaves them on.
    PREORDER_HOLDS_ENABLED?: string;
    // Per-SKU sale policy, {"SKU": {"saleMode": "in_stock" | "preorder" |
    // "sold_out", "shipPromise": string | null}}, one entry for every
    // storefront SKU or the catalog refuses to load. A Worker secret; the
    // launch script sets the campaign SKUs to preorder.
    SHOPIFY_PREVIEW_POLICY_JSON?: string;

    // Aggregate order totals behind the financial goal meter, as
    // {"orders": n, "revenue_eur": x, "updated_at": iso}. Read by
    // scripts/update-goals.mjs only. Unset, the script reports and changes
    // nothing.
    GOALS_URL?: string;

    // Opens /learn in a deployed build. The corpus behind it is unreviewed
    // research, so the routes 404 unless this is exactly '1'. Dev always
    // renders it. Drop the flag once the chapters pass the fact-check.
    PUBLIC_LEARN_DRAFT?: string;

    // Lifts the GitHub API ceiling from 60 to 5000 calls an hour for the
    // PDP's latest-commit card and contributor grid. Unauthenticated, a
    // handful of page loads exhausts the budget and the contributor grid
    // empties out. A fine-grained token with public read access is enough;
    // public repos need no scopes. Optional: unset, both degrade quietly.
    GITHUB_TOKEN?: string;

    // Same idea for the status-* topic fetch (roadmap kanban, ballot
    // candidates, PDP status chip). Optional: unset falls back to the
    // static statuses in app/lib/roadmap-data.ts once the 60/hour
    // unauthenticated budget runs out.
    GITHUB_STATUS_TOKEN?: string;

    // Coming-soon kill switch: unset/anything ≠ '0' renders every product
    // as coming soon (no prices, notify-me signup instead of add-to-cart).
    // Production and staging set it in their wrangler [vars]. Per-product
    // overrides live in content/products/<handle>.json (`status`).
    PUBLIC_COMING_SOON?: string;

    // US consumer preorders gate: exactly '1' opens the US to campaign
    // preorders, once content/us-sales.json also sets the US shipping rate
    // (app/lib/us-sales.ts). Anything else keeps the US on retailer
    // enquiries. Production and staging set it in their wrangler [vars].
    PUBLIC_US_SALES?: string;

    PUBLIC_COMPANY_NAME?: string;
    PUBLIC_COMPANY_ADDRESS?: string;
    PUBLIC_COMPANY_KBO?: string;
    PUBLIC_COMPANY_VAT?: string;
    PUBLIC_COMPANY_EMAIL?: string;
    PUBLIC_COMPANY_TEL?: string;

    // Public Discord invite for the community, linked from /support.
    DISCORD_SUPPORT_INVITE?: string;
    PUBLIC_DISCORD_INVITE?: string;

    // Support tickets (app/lib/support/, README "Support"). SUPPORT_DB is
    // the D1 ticket index; the conversation itself lives in one private
    // Discord thread per ticket under DISCORD_SUPPORT_CHANNEL_ID.
    SUPPORT_DB?: D1Database;
    DISCORD_BOT_TOKEN?: string;
    DISCORD_GUILD_ID?: string;
    DISCORD_SUPPORT_CHANNEL_ID?: string;
    DISCORD_STAFF_METADATA_CHANNEL_ID?: string;
    SUPPORT_MOD_ROLE_ID?: string;
    SUPPORT_MODERATION_MODE?: string;
    SUPPORT_APPROVE_EMOJI?: string;
    // Signs resume links and the ticket cookie.
    SUPPORT_SESSION_SECRET?: string;
    // Bearer token for POST /api/support/cleanup.
    SUPPORT_CLEANUP_SECRET?: string;
    // Support CRM (app/lib/support/crm.ts, README "Support tickets"). Both
    // flags are [vars], "1" on, off by default. SUPPORT_FILES is the R2
    // bucket for attachments (declared in the wrangler files once it exists).
    // The token and the Access settings are Worker secrets.
    SUPPORT_CRM_API?: string;
    SUPPORT_COMMUNITY_ROUTE?: string;
    SUPPORT_FILES?: R2Bucket;
    SUPPORT_STAFF_API_TOKEN?: string;
    // Bearer token for the full body of GET /api/status/campaign (paid counts, price sync, holds); without it the
    // route answers only allOpen and the status code. Worker secret.
    CAMPAIGN_STATUS_TOKEN?: string;
    SUPPORT_STAFF_ACCESS_TEAM_DOMAIN?: string;
    SUPPORT_STAFF_ACCESS_AUD?: string;
    SUPPORT_STAFF_ACCESS_CLIENT_ID?: string;
    // "1" turns on GET /api/editorial/manifest and /receipt (app/lib/editorial/api.ts): read-only evidence of the
    // build for the company app, same credential as the staff API. [vars], off by default.
    EDITORIAL_API?: string;
    // Workers version metadata (wrangler `[version_metadata]`): this deployment's version id and time.
    CF_VERSION_METADATA?: {id?: string; tag?: string; timestamp?: string};
    // Forum channel (public #help) that community questions are posted to.
    DISCORD_HELP_CHANNEL_ID?: string;
    // '1' emails "you have a new reply" (no content) through Resend.
    // Anything else sends nothing; turning it on needs the founder's go.
    SUPPORT_EMAIL_NOTIFY_ENABLED?: string;
    // '1' tags the matched Shopify customer `support` and records the
    // ticket in its `support.tickets` metafield.
    SUPPORT_SHOPIFY_WRITE_ENABLED?: string;
    // Dev server only (ignored in a build): point the Discord and Shopify
    // Admin calls at a local stub for end-to-end runs.
    SUPPORT_DEV_DISCORD_API?: string;
    SUPPORT_DEV_SHOPIFY_ADMIN_URL?: string;
    SUPPORT_DEV_GMAIL_API?: string;

    // Customer mail drafts (app/lib/support/mail.ts, README "Mail"). SUPPORT_MAIL_INTAKE_ENABLED is a [var]: "1" on, "dry" report
    // only, anything else off. SUPPORT_MAIL_SA_JSON (the service account key
    // file) and SUPPORT_MAIL_MAILBOX are Worker secrets; the allow and deny
    // lists may name suppliers, so they are secrets too, never in the repo.
    SUPPORT_MAIL_INTAKE_ENABLED?: string;
    SUPPORT_MAIL_SA_JSON?: string;
    SUPPORT_MAIL_MAILBOX?: string;
    SUPPORT_MAIL_ADDRESSES?: string;
    SUPPORT_MAIL_OWN_DOMAINS?: string;
    SUPPORT_MAIL_ALLOW?: string;
    SUPPORT_MAIL_DENY?: string;
    SUPPORT_MAIL_WINDOW_DAYS?: string;

    // Cloudflare Turnstile for the newsletter signup and support forms.
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    SUPPORT_TURNSTILE_DEV_SKIP?: string;
    RESEND_API_KEY?: string;
    SUPPORT_FROM_EMAIL?: string;

    // ChatFPV (app/lib/support/chatfpv.ts, README "Support tickets"). The
    // three switches are [vars], "1" to turn on; CHATFPV_KEY (the store key
    // for /v1/draft) is a Worker secret, read on the server only.
    CHATFPV_URL?: string;
    CHATFPV_KEY?: string;
    /** Service binding to the ChatFPV Worker ([[services]] in the wrangler configs). */
    CHATFPV?: Fetcher;
    CHATFPV_DRAFTS_ENABLED?: string;
    CHATFPV_ASK_ENABLED?: string;
    CHATFPV_WIDGET_ENABLED?: string;
    /** "1": ChatFPV handoff tickets (`#cfh`) open the product page widget (app/lib/accounts/handoff.ts). */
    HANDOFF_ENABLED?: string;

    // Shared accounts (app/lib/accounts/, README "Shared accounts").
    // ACCOUNTS_ENABLED "1" turns on /account/login, /account/callback,
    // /account/logout, /account, /oauth/* and /api/account/widget-assertion.
    // ACCOUNTS_TEST_IDP is never set in production; it is honoured only on
    // hosts other than opendrone.be and www.opendrone.be.
    ACCOUNTS_ENABLED?: string;
    // Early Bird Discord role (app/lib/early-bird.ts): the HMAC key shared with
    // the Discord bot Worker, which verifies the claim tokens signed with it.
    // A Worker secret; unset, claims answer "not open yet".
    EARLY_BIRD_CLAIM_KEY?: string;
    // The bot's claim route; default https://opendrone-discord-bot.sales-ee0.workers.dev/early-bird.
    EARLY_BIRD_CLAIM_URL?: string;
    ACCOUNTS_TEST_IDP?: string;
    /** "1": the owners map shows the aggregate fixture and never reads orders (app/lib/owner-map-data.ts). Never set in a deployed config; a test checks. */
    OWNER_MAP_FIXTURE?: string;
    /** "1" turns on the opt-in pilot map ("Find pilots near you" on /owners): Discord link, pins, /account card. Needs ACCOUNTS_ENABLED and SUPPORT_DB. Off in wrangler.production.toml until the founder's go (app/lib/pilot-map-data.ts). */
    PILOT_MAP_ENABLED?: string;
    /** Discord OAuth2 application for the pilot map, scope identify only. Worker secrets; unset, "Link Discord" is unavailable (the dev server uses a fake). */
    DISCORD_OAUTH_CLIENT_ID?: string;
    DISCORD_OAUTH_CLIENT_SECRET?: string;
    /** Callback registered at Discord; default `<origin>/owners/discord/callback`. */
    DISCORD_OAUTH_REDIRECT?: string;
    /** "1" (wrangler.production.toml only): ops alerts to DISCORD_STAFF_METADATA_CHANNEL_ID, once per UTC day per key (app/lib/ops-alerts.ts). */
    OPS_ALERTS_ENABLED?: string;
    /** Space-separated Shopify Customer Account API scope override; default `openid email` (shopify-idp.ts). */
    SHOPIFY_CUSTOMER_ACCOUNT_SCOPE?: string;
    /** Exact-match, comma-separated redirect_uri allowlist for the `chatfpv` OAuth client. */
    CHATFPV_OAUTH_REDIRECTS?: string;
    /** Exact-match, comma-separated post_logout_redirect_uri allowlist for /oauth/logout. */
    CHATFPV_POST_LOGOUT_REDIRECTS?: string;
    // Secrets (wrangler secret put).
    SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID?: string;
    SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET?: string;
    /** Numeric shop id; discovery base https://shopify.com/authentication/<id>. Ignored when SHOPIFY_CUSTOMER_ACCOUNT_ISSUER is set. */
    SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID?: string;
    /** OIDC discovery base (issuer), overriding SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID. */
    SHOPIFY_CUSTOMER_ACCOUNT_ISSUER?: string;
    ACCOUNT_PAIRWISE_SALT?: string;
    SESSION_ENC_KEY?: string;
    CHATFPV_OAUTH_CLIENT_SECRET?: string;
    WIDGET_ASSERTION_KEY?: string;

    // Newsletter / release-notes auto-dispatch
    // - NEWSLETTER_DISPATCH_SECRET: bearer token for the manual dispatch
    //   trigger (CLI/curl) AND HMAC key for per-recipient unsubscribe
    //   tokens. Rotate together, old unsubscribe links die on rotate.
    // - NEWSLETTER_FROM_EMAIL: sender address, e.g. news@opendrone.be.
    //   Domain must be verified in Resend (SPF/DKIM/DMARC).
    // - NEWSLETTER_DISPATCH_KV: dedup ledger so a repeated dispatch does
    //   not double-send. Optional but recommended.
    NEWSLETTER_DISPATCH_SECRET?: string;
    NEWSLETTER_FROM_EMAIL?: string;
    NEWSLETTER_DISPATCH_KV?: KVNamespace;
  }
}
