/// <reference types="vite/client" />
/// <reference types="react-router" />

// Enhance TypeScript's built-in typings.
import '@total-typescript/ts-reset';

// Extend the Worker Env interface with project env vars so context.env.* is
// strongly typed in routes.
declare global {
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

  // Cloudflare Workers Rate Limiting binding (wrangler.toml
  // `[[ratelimits]]`), declared minimally like KVNamespace above.
  interface RateLimit {
    limit(options: {key: string}): Promise<{success: boolean}>;
  }

  interface Env {
    // Signs the locale and cart session cookies.
    SESSION_SECRET: string;

    // Checkout mutation gate. The catalog stays read-only unless this is
    // explicitly enabled.
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
    SHOPIFY_PREVIEW_POLICY_JSON?: string;

    // Aggregate order totals behind the financial goal meter, as
    // {"orders": n, "revenue_eur": x, "updated_at": iso}. Read by
    // scripts/update-goals.mjs only. Unset, the script reports and changes
    // nothing.
    GOALS_URL?: string;

    // Pre-launch banner kill switch: unset/anything ≠ '0' keeps the banner.
    PUBLIC_PRELAUNCH?: string;

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
    // Set PUBLIC_COMING_SOON=0 in Oxygen the day orders open. Per-product
    // overrides live in app/lib/product-content.ts (`comingSoon`).
    PUBLIC_COMING_SOON?: string;

    PUBLIC_COMPANY_NAME?: string;
    PUBLIC_COMPANY_ADDRESS?: string;
    PUBLIC_COMPANY_KBO?: string;
    PUBLIC_COMPANY_VAT?: string;
    PUBLIC_COMPANY_EMAIL?: string;
    PUBLIC_COMPANY_TEL?: string;

    // Public Discord invite used by /support and the /contact card.
    DISCORD_SUPPORT_INVITE?: string;
    PUBLIC_DISCORD_INVITE?: string;
    // Cloudflare Turnstile for the newsletter signup.
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    SUPPORT_TURNSTILE_DEV_SKIP?: string;
    RESEND_API_KEY?: string;
    SUPPORT_FROM_EMAIL?: string;

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
