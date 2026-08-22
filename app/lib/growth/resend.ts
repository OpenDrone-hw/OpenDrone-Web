/**
 * Resend MARKETING client — contact upsert, per-SKU interest segments,
 * and the launch-list welcome email.
 *
 * Scope guard: marketing email only. Transactional support mail lives in
 * app/lib/support/email.ts — keep the two apart (different from-address,
 * different audience, different failure story). This module never sends
 * on behalf of the support bridge.
 *
 * Resend model (verified LIVE against the production account
 * 2026-07-21, which still exposes the audiences-era API): contacts are
 * global, Segments alias Audiences 1:1, and Broadcasts target a
 * `segment_id` — hence the per-SKU strategy: every notify signup for
 * <handle> is added to a segment named `notify-<handle>` (mirroring the
 * Shopify customer tag), so "email everyone interested in <handle>" is
 * one Broadcast at that segment (scripts/launch-blast.mjs). Custom
 * contact `properties` are NOT usable on this account (422 unless
 * declared first; no API to declare them). Endpoints used:
 *
 *   POST   /contacts                                   create (segments: [{id}])
 *   POST   /contacts/{email}/segments/{segment_id}     add membership
 *   PATCH  /contacts/{email}                           unsubscribe flag
 *   GET    /segments?limit=100[&after=]                find by name
 *   POST   /segments                                   create by name
 *   POST   /emails                                     welcome (transactional)
 *
 * Degrade-soft rule (same as support/email.ts): RESEND_API_KEY unset →
 * console.warn + no-op. Every export returns a success boolean and never
 * throws — marketing plumbing must not break a signup.
 *
 * GDPR: contacts are created only from the consent-checked newsletter
 * form. RtbF for a subscriber = DEL the `sig:<email>` ledger record
 * (app/lib/growth/ledger.ts) + DELETE /contacts/{email} here.
 */

const RESEND_API = 'https://api.resend.com';

type MarketingEnv = {
  RESEND_API_KEY?: string;
  /**
   * Marketing from-address (welcome email, broadcasts). Defaults to
   * hello@opendrone.be — domain must be verified in Resend for it.
   */
  RESEND_MARKETING_FROM?: string;
  SUPPORT_FROM_EMAIL?: string;
};

type ApiResult = {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
};

async function api(
  env: MarketingEnv,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const res = await fetch(`${RESEND_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Empty/non-JSON body — status is enough for callers.
  }
  return {ok: res.ok, status: res.status, json};
}

/** Segment name for per-SKU launch interest — mirrors the Shopify tag. */
export function notifySegmentName(productHandle: string): string {
  return `notify-${productHandle}`;
}

// Per-isolate cache: segment names are stable, ids never change, and a
// busy launch page would otherwise do a list-segments round trip per
// signup. Cold isolates just re-resolve once.
const segmentIdCache = new Map<string, string>();

/**
 * Resolve a segment id by name, creating the segment when missing.
 * Returns null on any failure (caller degrades to a property-only
 * contact — the launch-blast script re-syncs membership later).
 */
async function ensureSegmentId(
  env: MarketingEnv,
  name: string,
): Promise<string | null> {
  const cached = segmentIdCache.get(name);
  if (cached) return cached;

  let after: string | null = null;
  // Cursor pagination, hard-capped — we expect ~1 segment per SKU.
  for (let i = 0; i < 10; i++) {
    const query: string = after
      ? `?limit=100&after=${encodeURIComponent(after)}`
      : '?limit=100';
    const r = await api(env, 'GET', `/segments${query}`);
    if (!r.ok) break;
    const items = (r.json?.data ?? []) as Array<{id?: string; name?: string}>;
    const hit = items.find((s) => s.name === name);
    if (hit?.id) {
      segmentIdCache.set(name, hit.id);
      return hit.id;
    }
    if (!r.json?.has_more || items.length === 0) break;
    after = items[items.length - 1]?.id ?? null;
    if (!after) break;
  }

  const created = await api(env, 'POST', '/segments', {name});
  const id = typeof created.json?.id === 'string' ? created.json.id : null;
  if (created.ok && id) {
    segmentIdCache.set(name, id);
    return id;
  }
  console.warn('[growth/resend] segment resolve failed', name, created.status);
  return null;
}

/**
 * Create-or-merge a marketing contact. `product` additionally files the
 * contact into the `notify-<product>` segment. `unsubscribed` is never
 * touched, so an opt-out always survives a re-signup.
 *
 * API shapes verified live against the production account 2026-07-21:
 * POST /contacts requires `segments` as an array of OBJECTS
 * (`[{id}]`, not `[id]` — strings 422), and custom `properties` 422
 * unless declared account-side first, which this plan cannot do via
 * API. locale/channel therefore stay ledger-only (sig:<email> is the
 * source of truth anyway) and are accepted here only for call-site
 * compatibility.
 */
export async function upsertContact(
  env: MarketingEnv,
  opts: {email: string; locale?: string; channel?: string; product?: string},
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      '[growth/resend] RESEND_API_KEY not set — contact upsert skipped',
    );
    return false;
  }
  try {
    const segmentId = opts.product
      ? await ensureSegmentId(env, notifySegmentName(opts.product))
      : null;

    const created = await api(env, 'POST', '/contacts', {
      email: opts.email,
      ...(segmentId ? {segments: [{id: segmentId}]} : {}),
    });
    if (created.ok) return true;

    // Existing contact (or transient create failure) → membership add is
    // the only remaining write. Deliberately no `unsubscribed` field
    // anywhere in this path.
    if (segmentId) {
      const seg = await api(
        env,
        'POST',
        `/contacts/${encodeURIComponent(opts.email)}/segments/${segmentId}`,
      );
      if (!seg.ok) {
        console.warn(
          '[growth/resend] contact upsert failed',
          created.status,
          seg.status,
        );
        return false;
      }
      return true;
    }
    console.warn('[growth/resend] contact create failed', created.status);
    return false;
  } catch (err) {
    console.warn('[growth/resend] upsertContact failed', err);
    return false;
  }
}

/**
 * Mark a contact unsubscribed (suppression, not deletion: a re-signup
 * never silently resubscribes, matching upsertContact's merge rule).
 * Best-effort: false on any miss, throws never.
 */
export async function unsubscribeContact(
  env: MarketingEnv,
  email: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      '[growth/resend] RESEND_API_KEY not set — unsubscribe skipped',
    );
    return false;
  }
  try {
    const res = await api(
      env,
      'PATCH',
      `/contacts/${encodeURIComponent(email)}`,
      {unsubscribed: true},
    );
    if (!res.ok) {
      console.warn('[growth/resend] contact unsubscribe failed', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[growth/resend] contact unsubscribe failed', err);
    return false;
  }
}

/**
 * Create-and-send a back-in-stock broadcast to the `notify-<handle>`
 * segment (the same segment every notify signup lands in). Resend
 * suppresses unsubscribed contacts at send time, and the body embeds
 * the {{{RESEND_UNSUBSCRIBE_URL}}} footer variable, resolved per
 * recipient. Best-effort: false on any miss, throws never — the caller
 * (app/lib/growth/back-in-stock.ts) releases its cooldown latch on
 * false so a webhook redelivery can retry.
 */
export async function sendBackInStockBroadcast(
  env: MarketingEnv,
  opts: {productHandle: string; productTitle: string},
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn(
      '[growth/resend] RESEND_API_KEY not set — back-in-stock skipped',
    );
    return false;
  }
  try {
    const segmentId = await ensureSegmentId(
      env,
      notifySegmentName(opts.productHandle),
    );
    if (!segmentId) return false;
    const from = env.RESEND_MARKETING_FROM || 'hello@opendrone.be';
    const productUrl = `https://opendrone.be/products/${opts.productHandle}`;
    const subject = `Back in stock: ${opts.productTitle}`;
    const text = [
      'Hi,',
      '',
      `${opts.productTitle} is back in stock at opendrone.be.`,
      '',
      `Get it here: ${productUrl}`,
      '',
      'You get this because you asked to be notified about this product.',
      'Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}',
      '',
      'OpenDrone',
    ].join('\n');
    const html = renderMarketingEmail({
      heading: 'Back in stock',
      body: `
      <p>Hi,</p>
      <p><strong>${escapeHtml(opts.productTitle)}</strong> is back in stock.</p>
      <p style="margin:24px 0 32px">
        <a href="${escapeAttr(productUrl)}" style="display:inline-block;background:#ffb700;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;padding:12px 18px;border-radius:2px">View product →</a>
      </p>
      <p style="color:#737373;font-size:13px;line-height:1.6">You get this because you asked to be notified about this product. <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#ffb700">Unsubscribe</a>.</p>
    `,
    });
    const res = await api(env, 'POST', '/broadcasts', {
      name: `back-in-stock-${opts.productHandle}`,
      segment_id: segmentId,
      from: `OpenDrone <${from}>`,
      subject,
      html,
      text,
      send: true,
    });
    if (!res.ok) {
      console.warn('[growth/resend] back-in-stock broadcast failed', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[growth/resend] back-in-stock broadcast failed', err);
    return false;
  }
}

/**
 * One-time welcome email, fired on the FIRST signup for an address only
 * (the caller gates on the ledger's created flag). Transactional send —
 * a direct response to the form submit, so no List-Unsubscribe needed —
 * but the body states exactly what was signed up for + how to reach us.
 */
export async function sendWelcome(
  env: MarketingEnv,
  opts: {email: string; product?: string; unsubscribeUrl?: string | null},
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('[growth/resend] RESEND_API_KEY not set — welcome skipped');
    return false;
  }
  const from = env.RESEND_MARKETING_FROM || 'hello@opendrone.be';
  const supportEmail = env.SUPPORT_FROM_EMAIL || 'support@opendrone.be';
  const {subject, text, html} = renderWelcome({
    product: opts.product,
    supportEmail,
    unsubscribeUrl: opts.unsubscribeUrl,
  });
  try {
    const res = await api(env, 'POST', '/emails', {
      from: `OpenDrone <${from}>`,
      to: [opts.email],
      subject,
      text,
      html,
      reply_to: supportEmail,
    });
    if (!res.ok) {
      console.warn('[growth/resend] welcome send failed', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[growth/resend] welcome send failed', err);
    return false;
  }
}

// --- welcome template -------------------------------------------------------
// TODO(copy): all subscriber-facing copy below is a factual draft —
// rewrite in your own voice.

// Display titles for the launch-list line. The signup form posts the Shopify
// product handle; without this map the email reads "launch list: openfc-lite".
const PRODUCT_TITLES: Record<string, string> = {
  openrx: 'OpenRX',
  openesc: 'OpenESC',
  'openfc-lite': 'OpenFC Lite',
  'openfc-lite-mini': 'OpenFC Lite Mini',
  openframe: 'OpenFrame',
};

function productDisplayTitle(handle: string): string {
  return (
    PRODUCT_TITLES[handle] ??
    // Unknown handle: de-slug so it at least reads as words.
    handle
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

// Fallback when no signed one-click link is available (SESSION_SECRET
// unset): the page's manual form, same route.
const UNSUBSCRIBE_PAGE = 'https://opendrone.be/newsletter/unsubscribe';

function renderWelcome(opts: {
  product?: string;
  supportEmail: string;
  unsubscribeUrl?: string | null;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const {product: productHandle, supportEmail} = opts;
  const unsubscribeUrl = opts.unsubscribeUrl || UNSUBSCRIBE_PAGE;
  const product = productHandle
    ? productDisplayTitle(productHandle)
    : undefined;
  const subject = product
    ? `You're on the launch list: ${product}`
    : 'Subscribed: Engineering Essentials';

  const contextLine = product
    ? `You signed up for launch updates for ${product} at opendrone.be.`
    : `You signed up for the Engineering Essentials newsletter at opendrone.be.`;

  const text = [
    'Hi,',
    '',
    product
      ? `You're on the launch list for ${product}. One email when it goes on sale, plus the occasional engineering note. Nothing else.`
      : `You're subscribed to Engineering Essentials: engineering notes, hardware releases, and write-ups. Only when there's something to ship.`,
    '',
    `${contextLine} Not you, or changed your mind? Unsubscribe here: ${unsubscribeUrl}`,
    '',
    'OpenDrone',
  ].join('\n');

  const html = renderMarketingEmail({
    heading: product ? "You're on the launch list" : "You're subscribed",
    body: `
      <p>Hi,</p>
      <p>${
        product
          ? `You're on the launch list for <strong>${escapeHtml(product)}</strong>. One email when it goes on sale, plus the occasional engineering note. Nothing else.`
          : `You're subscribed to Engineering Essentials: engineering notes, hardware releases, and write-ups. Only when there's something to ship.`
      }</p>
      <p style="color:#737373;font-size:13px;line-height:1.6;margin-top:28px">${escapeHtml(contextLine)} Not you, or changed your mind? <a href="${escapeAttr(unsubscribeUrl)}" style="color:#ffb700">Unsubscribe</a> with one click, or write <a href="mailto:${escapeAttr(supportEmail)}" style="color:#ffb700">${escapeHtml(supportEmail)}</a>.</p>
    `,
  });

  return {subject, text, html};
}

/**
 * Marketing shell — same aesthetic as the support template
 * (app/lib/support/email.ts renderEmail), duplicated on purpose: the
 * support module is transactional-only and this one must not import it.
 */
function renderMarketingEmail({
  heading,
  body,
}: {
  heading: string;
  body: string;
}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;font-family:Helvetica,Arial,sans-serif;line-height:1.55">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141417;border:1px solid #1a241a;border-radius:3px">
        <tr><td bgcolor="#ffffff" style="padding:16px 28px;background:#ffffff">
          <img src="https://cdn.shopify.com/s/files/1/1032/6641/9033/files/opendrone-wordmark-email-blackgold_39eb37d0-777f-4a31-b2f3-eb25965c97d7.png?v=1786703416" alt="OpenDrone" width="160" height="39" style="display:block;border:0;height:39px;width:160px" />
        </td></tr>
        <tr><td style="padding:24px 28px 0">
          <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;letter-spacing:-0.01em;margin:0;color:#e5e5e5">${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:18px 28px 28px;color:#e5e5e5;font-size:15px">${body}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
