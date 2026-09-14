/**
 * Back-in-stock notify — turns a restock event into ONE Resend broadcast
 * to the `notify-<handle>` segment (the same segment every PDP notify
 * signup lands in).
 *
 * The trigger used to be a Shopify `inventory_levels/update` webhook. That
 * receiver is gone with the store; Odoo will post restock events to the
 * growth ledger in phase 6 (an `incutec_growth` module). This module is
 * the side-effecting half, kept whole so that step only has to call it
 * with a handle and a title.
 *
 * Pipeline (all best-effort, everything degrades to warn + no-op):
 *
 *   restock(handle)
 *     → guard: not coming-soon (the launch-blast flow owns comms while a
 *       product is still notify-at-launch)
 *     → cooldown latch `bis:<handle>` (SET NX EX, 7 days) so a restock
 *       that flaps in and out of stock cannot re-blast the segment
 *     → Resend broadcast to notify-<handle> (send: true)
 *
 * The latch is released when the broadcast fails, so a redelivered event
 * retries cleanly. When Upstash is unconfigured the latch cannot
 * arbitrate — we SKIP rather than risk double-blasting a marketing email
 * (opposite default from the ledger writers, where a dropped record is
 * the cheaper failure).
 */

import {isComingSoon} from '~/lib/product-content';
import {comingSoonFlag} from '~/lib/coming-soon';
import {fetchStatusFlags} from '~/lib/roadmap-data';
import {sendBackInStockBroadcast} from '~/lib/growth/resend';
import {deleteKey, setIfAbsentTtl, type UpstashEnv} from '~/lib/support/upstash';

const COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

// Derive the marketing env shape from the helper itself so this module
// can never drift from what it actually needs.
type BackInStockEnv = UpstashEnv &
  Parameters<typeof sendBackInStockBroadcast>[0] & {
    PUBLIC_COMING_SOON?: string;
    GITHUB_STATUS_TOKEN?: string;
  };

/**
 * Full handler, meant to run in waitUntil after the caller has ACKed its
 * event. Never throws.
 */
export async function handleRestock(
  env: BackInStockEnv,
  product: {handle: string; title: string},
): Promise<void> {
  try {
    // Resolve with the LIVE topic flags, like every other server surface:
    // with static-only resolution the mandated static-lags-topic discipline
    // would misread a freshly released (topic-beta, static-alpha) board as
    // pre-launch and silently kill its restock mail. The caller runs this
    // in waitUntil, so the full fetch's latency is free here. Note for the
    // release runbook: a stock top-up right after a topic flip will fire
    // this blast — coordinate it with the manual launch mail.
    const statusFlags = await fetchStatusFlags(env.GITHUB_STATUS_TOKEN).catch(
      () => ({}),
    );
    if (isComingSoon(product.handle, comingSoonFlag(env), statusFlags)) {
      // Pre-launch products: interest is answered by the launch blast,
      // not a restock mail.
      return;
    }

    const latchKey = `bis:${product.handle}`;
    const claimed = await setIfAbsentTtl(
      env,
      latchKey,
      String(Math.floor(Date.now() / 1000)),
      COOLDOWN_SECONDS,
    );
    if (claimed === null) {
      console.warn('[growth/bis] Upstash unconfigured — restock notify skipped');
      return;
    }
    if (!claimed) return; // notified within the cooldown window

    const sent = await sendBackInStockBroadcast(env, {
      productHandle: product.handle,
      productTitle: product.title,
    });
    if (!sent) {
      // Free the latch so a redelivered event can retry the send.
      await deleteKey(env, latchKey);
    }
  } catch (err) {
    console.warn('[growth/bis] handleRestock failed', err);
  }
}
