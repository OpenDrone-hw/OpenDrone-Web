/**
 * Review UI for the PDP. The aggregate (average and count) comes from
 * the Odoo catalog feed, which reads Odoo's own published product
 * ratings; the review bodies live on the shop product page, where a
 * signed-in customer writes them. No third party (contract section 6).
 *
 * Engineering-document styling: hairline rows, JetBrains Mono numerals,
 * tokens only (see the "PDP reviews" section in app/styles/app.css).
 */

export type ReviewAggregate = {value: number; count: number};

const STARS_FILLED = '★★★★★';
const STARS_EMPTY = '☆☆☆☆☆';

/** The catalog's rating as the aggregate, or null when nobody rated. */
export function toReviewAggregate(
  rating: {average: number; count: number} | null | undefined,
): ReviewAggregate | null {
  if (!rating || !rating.count) return null;
  return {value: rating.average, count: rating.count};
}

/** Five mono star glyphs, filled to the rounded rating. */
export function ReviewStars({rating}: {rating: number}) {
  const filled = Math.min(5, Math.max(0, Math.round(rating)));
  return (
    <span
      className="review-stars"
      role="img"
      aria-label={`Rated ${rating} out of 5`}
    >
      <span aria-hidden="true">
        {STARS_FILLED.slice(0, filled)}
        {STARS_EMPTY.slice(0, 5 - filled)}
      </span>
    </span>
  );
}

/**
 * Buy-area aggregate line: stars, average, count. Links to the reviews
 * chapter further down the page. Renders nothing without an aggregate,
 * so a product with zero reviews shows no trace of the feature.
 */
export function ReviewAggregateLine({
  aggregate,
}: {
  aggregate: ReviewAggregate | null;
}) {
  if (!aggregate) return null;
  return (
    <a className="product-buy-reviews" href="#reviews">
      <ReviewStars rating={aggregate.value} />
      <span className="product-buy-reviews-count">
        {aggregate.value.toFixed(1)} · {aggregate.count}{' '}
        {aggregate.count === 1 ? 'review' : 'reviews'}
      </span>
    </a>
  );
}

/**
 * The chapter body: the aggregate in full, and a link to the shop
 * product page where the reviews are read and written.
 */
export function ReviewList({
  aggregate,
  shopUrl,
}: {
  aggregate: ReviewAggregate;
  shopUrl: string | null;
}) {
  return (
    <>
      <p className="review-count-line">
        <ReviewStars rating={aggregate.value} /> {aggregate.value.toFixed(1)} out
        of 5, from {aggregate.count}{' '}
        {aggregate.count === 1 ? 'review' : 'reviews'}.
      </p>
      {shopUrl ? (
        <p className="review-count-line">
          <a href={shopUrl} target="_blank" rel="noopener noreferrer">
            Read the reviews
          </a>
        </p>
      ) : null}
    </>
  );
}
