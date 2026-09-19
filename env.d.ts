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
    // Signs the locale and support-desk cookies.
    SESSION_SECRET: string;

    // The Incutec shop on Odoo: base of every buy hand-off and portal
    // link, and the fallback base when the catalog is unreachable.
    // Defaults to https://shop.incutec.com.
    PUBLIC_SHOP_URL?: string;

    // The Odoo catalog feed (module incutec_catalog_api). Defaults to
    // https://erp.incutec.com/incutec/catalog.json. Fetched server-side
    // with a 5 minute worker cache; the last good copy is served for up
    // to an hour if the fetch fails.
    CATALOG_URL?: string;
    // Optional server-side Basic auth for a protected catalog origin (the
    // Cloudflare preview Worker points CATALOG_URL at staging, which sits
    // behind auth; production leaves these unset).
    CATALOG_HTTP_USER?: string;
    CATALOG_HTTP_PASSWORD?: string;

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

    // Newsletter double opt-in bridge (erp PLAN.md 13.11, Odoo module
    // incutec_catalog_api, app/lib/growth/odoo-newsletter.ts). Every
    // signup is a server-to-server POST to Odoo, which mails the
    // confirmation link itself and only joins the "Newsletter"
    // mailing.list once it is followed; unsubscribing uses Odoo's own
    // mailing link, so this repository holds no Resend audience, contact
    // or unsubscribe-token code any more. NEWSLETTER_ODOO_URL defaults to
    // https://erp.incutec.eu. NEWSLETTER_DISPATCH_SECRET must match the
    // system parameter incutec_catalog_api.newsletter_dispatch_secret,
    // set from env $NEWSLETTER_DISPATCH_SECRET by erp/config/configure.py
    // (--section catalog_api). Unset, signup fails closed (no mail sent).
    NEWSLETTER_ODOO_URL?: string;
    NEWSLETTER_DISPATCH_SECRET?: string;

    // Stage 2 moderation gate
    SUPPORT_MOD_ROLE_ID?: string;
    SUPPORT_APPROVE_EMOJI?: string;
    SUPPORT_MODERATION_MODE?: string;

    // Ticket state and lookup - Odoo (erp/addons/incutec_support,
    // PLAN.md 12.2, app/lib/support/odoo.ts). Every Discord ticket and
    // message is best-effort mirrored into Odoo `project.task`, which is
    // also the storefront's ticket index (close/cursors/feedback/lookup):
    // there is no separate KV store any more (Upstash Redis removed
    // entirely, founder decision, 2026-09-15). Unset or unreachable, the
    // Discord-only bridge is unaffected (D13). SUPPORT_ODOO_URL defaults
    // to https://erp.incutec.eu.
    SUPPORT_ODOO_URL?: string;
    SUPPORT_ODOO_TOKEN?: string;

    // Workers Rate Limiting bindings (wrangler.toml `[[ratelimits]]`) for
    // /api/support/lookup's "resume by email" abuse defence - distributed
    // across isolates, unlike app/lib/rate-limit.ts's in-memory limiter.
    // Replaced Upstash-backed global counters (founder decision,
    // 2026-09-15). Cloudflare's platform ceiling is a 10s/60s window, so
    // these approximate the former 10-minute IP cap and 24-hour email cap
    // as 60s windows at the same request counts (app/routes/
    // api.support.lookup.tsx). Optional because local dev has no binding
    // - the route falls back to the in-memory limiter.
    SUPPORT_LOOKUP_IP_LIMITER?: RateLimit;
    SUPPORT_LOOKUP_EMAIL_LIMITER?: RateLimit;

    // Bearer token for /api/support/cleanup. The daily GitHub Actions
    // cron (.github/workflows/support-cleanup.yml) sends this in the
    // Authorization header. Without it the endpoint returns 503 - set
    // it to enable automatic stale-ticket sweeping.
    SUPPORT_CLEANUP_SECRET?: string;
    DISCORD_FEEDBACK_CHANNEL_ID?: string;

    // Bearer token for /api/support/relay, the outbound half of the
    // support bridge (erp/docs/integrations/discord.md, D1). Odoo sends
    // this when a staff member's public chatter comment has to reach the
    // Discord thread; it must match the system parameter
    // incutec_support.relay_token on the Odoo side (set from env
    // SUPPORT_RELAY_SECRET by erp/config/support.py). Separate from
    // SUPPORT_ODOO_TOKEN on purpose: a leak of one direction's secret
    // must not grant the other. Unset, the route returns 503 and the
    // Odoo side stays inert.
    SUPPORT_RELAY_SECRET?: string;

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
