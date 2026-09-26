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

  // Cloudflare Workers Rate Limiting binding (wrangler.toml
  // `[[ratelimits]]`), declared minimally like KVNamespace above.
  interface RateLimit {
    limit(options: {key: string}): Promise<{success: boolean}>;
  }

  interface Env {
    // Signs the locale and cart session cookies.
    SESSION_SECRET: string;

    // Checkout mutation gate. The catalog stays read-only unless this is
    // exactly '1'. Production and staging set it in their wrangler [vars].
    SHOPIFY_CHECKOUT_WRITE_ENABLED?: string;
    SHOPIFY_STORE_DOMAIN?: string;
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
    // Staging gate: when set, the Worker asks for HTTP basic auth as
    // "opendrone" with this password before serving anything. Production
    // leaves it unset.
    STAGING_PASSWORD?: string;
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
