// Forward-only poll cursor logic for the Discord -> web-support bridge.
//
// The poll route (api.support.poll) tracks a per-ticket cursor in the
// signed cookie: each poll fetches Discord messages newer than the
// cursor, then rolls the cursor forward. The subtlety this module owns
// is that the cursor must NOT advance past a message still held by the
// moderation gate (Stage 2).
//
// Why: a held staff reply can be approved (✅) on a later poll. If the
// cursor has already skipped it, the next delta fetch (`after=cursor`)
// will never return it again, and the customer has to do a full refresh
// (?initial=1) to surface a reply that was approved seconds after it
// arrived. Parking the cursor immediately before the earliest held
// message keeps the window re-fetching that message until it clears.

/**
 * Compute the cursor to persist after a poll.
 *
 * @param messages  This poll's fetched window, oldest -> newest.
 * @param heldIds   Ids of messages held by the moderation gate in this
 *                  window (enforce mode only; empty in log/off mode,
 *                  where dropped messages are still delivered and are
 *                  therefore terminal - the cursor may pass them).
 * @param lastCursor  The cursor the ticket carried into this poll.
 * @returns The cursor to store. With no held messages it is the newest
 *   message id (normal forward progress). With held messages it is the
 *   id immediately before the earliest held one - or `lastCursor`
 *   unchanged when the oldest message in the window is itself held
 *   (advancing at all would skip it the instant it's approved).
 */
export function computeCursorTarget(
  messages: Array<{id: string}>,
  heldIds: Set<string>,
  lastCursor: string | undefined,
): string | undefined {
  const newestId = messages.length
    ? messages[messages.length - 1].id
    : undefined;
  if (!heldIds.size) return newestId ?? lastCursor;
  const earliestHeldIdx = messages.findIndex((m) => heldIds.has(m.id));
  if (earliestHeldIdx <= 0) return lastCursor || undefined;
  return messages[earliestHeldIdx - 1].id;
}
