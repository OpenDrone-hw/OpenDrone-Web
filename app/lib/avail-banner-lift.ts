/**
 * How far (px) the availability card must rise above its resting place so it
 * does not cover a page element that asked to stay clear of it
 * (`data-avail-avoid`, e.g. the homepage hero's wordmark and GitHub link,
 * which sit in the same bottom-left corner on short viewports).
 *
 * Pure geometry, so it is testable without a DOM. `card` is the card's box at
 * rest (no lift). An element counts when it is on screen and overlaps the
 * card's column; the card then sits `gap` px above its top. Raising the card
 * can bring it onto a higher element, so this repeats until nothing overlaps.
 */
export type Box = {top: number; bottom: number; left: number; right: number};

export function availBannerLift(card: Box, avoid: readonly Box[], viewportHeight: number, gap: number): number {
  const onScreen = avoid.filter(
    (a) => a.bottom > a.top && a.right > a.left && a.bottom > 0 && a.top < viewportHeight && a.left < card.right && a.right > card.left,
  );
  let lift = 0;
  for (let i = 0; i <= onScreen.length; i++) {
    const top = card.top - lift;
    const bottom = card.bottom - lift;
    const hit = onScreen.filter((a) => a.top < bottom + gap && a.bottom > top - gap);
    if (!hit.length) break;
    lift = Math.max(lift, Math.ceil(card.bottom - Math.min(...hit.map((a) => a.top)) + gap));
  }
  return lift;
}
