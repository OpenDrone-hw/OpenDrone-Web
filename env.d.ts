/// <reference types="vite/client" />
/// <reference types="react-router" />
/// <reference types="@shopify/oxygen-workers-types" />
/// <reference types="@shopify/hydrogen/react-router-types" />

// Enhance TypeScript's built-in typings.
import '@total-typescript/ts-reset';

// Extend the Oxygen-provided Env interface with project env vars so
// context.env.* is strongly typed in routes.
declare global {
  // Minimal KVNamespace shape — Oxygen provides the binding at runtime
  // but doesn't re-export Cloudflare's type definition. Only the
  // methods we actually call are declared. Replace with the full
  // @cloudflare/workers-types KVNamespace if that package gets added.
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

  interface Env {
    // Signs the locale and support-desk cookies.
    SESSION_SECRET: string;

    // The Incutec shop on Odoo: base of every buy hand-off and portal
    // link, and the fallback base when the catalog is unreachable.
    // Defaults to https://shop.incutec.com.
    PUBLIC_SHOP_URL?: string;

    // The Odoo catalog feed (module incutec_catalog_api). Defaults to
    // https://erp.incutec.eu/incutec/catalog.json. Fetched server-side
    // with a 5 minute worker cache; the last good copy is served for up
    // to an hour if the fetch fails.
    CATALOG_URL?: string;

    // Aggregate order totals behind the financial goal meter, as
    // {"orders": n, "revenue_eur": x, "updated_at": iso}. Read by
    // scripts/update-goals.mjs only; the Odoo endpoint that serves it is
    // ERP PLAN.md step 12.6. Unset, the script reports and changes
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

    // Web support bridge
    DISCORD_BOT_TOKEN?: string;
    DISCORD_SUPPORT_CHANNEL_ID?: string;
    DISCORD_GUILD_ID?: string;
    DISCORD_STAFF_METADATA_CHANNEL_ID?: string;
    DISCORD_SUPPORT_INVITE?: string;
    // Public-facing guild identifiers used by the /contact invite card.
    // Distinct from the bridge-side bindings so the public card can be
    // wired without exposing support-bridge state.
    PUBLIC_DISCORD_GUILD_ID?: string;
    PUBLIC_DISCORD_INVITE?: string;
    SUPPORT_SESSION_SECRET?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    SUPPORT_TURNSTILE_DEV_SKIP?: string;
    RESEND_API_KEY?: string;
    SUPPORT_FROM_EMAIL?: string;

    // Marketing email (growth, app/lib/growth/resend.ts). Reuses
    // RESEND_API_KEY — the key must have access to Resend
    // Contacts/Segments/Broadcasts, not just transactional sends.
    // From-address for the launch-list welcome email + broadcasts;
    // defaults to hello@opendrone.be. Domain must be verified in Resend.
    RESEND_MARKETING_FROM?: string;

    // Stage 2 moderation gate
    SUPPORT_MOD_ROLE_ID?: string;
    SUPPORT_APPROVE_EMOJI?: string;
    SUPPORT_MODERATION_MODE?: string;

    // Stage 6 ticket index — Upstash Redis REST credentials. Oxygen
    // does not expose Cloudflare KV bindings, so we hit Upstash over
    // HTTPS instead. When unset, list operations degrade to a Discord
    // forum scan (slow, fine at <100 tickets total). Required before
    // scaling beyond a few hundred tickets.
    UPSTASH_REDIS_REST_URL?: string;
    UPSTASH_REDIS_REST_TOKEN?: string;

    // Bearer token for /api/support/cleanup. The daily GitHub Actions
    // cron (.github/workflows/support-cleanup.yml) sends this in the
    // Authorization header. Without it the endpoint returns 503 — set
    // it to enable automatic stale-ticket sweeping.
    SUPPORT_CLEANUP_SECRET?: string;
    DISCORD_FEEDBACK_CHANNEL_ID?: string;

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
