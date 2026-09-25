/**
 * Review UI for the PDP. The aggregate (average and count) comes from
 * the catalog's `rating` field, which the Shopify adapter leaves null, so
 * the chapter renders only once a rating source is wired in. No third
 * party.
 *
 * Engineering-document styling: hairline rows, JetBrains Mono numerals,
 * tokens only (see the "PDP reviews" section in app/styles/app.css).
 */

import {copyFill, copyText} from '~/lib/copy';

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
      aria-label={copyFill('product-chrome.reviews_stars_aria', 'Rated {rating} out of 5', {rating})}
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
        {aggregate.count === 1
          ? (copyText('product-chrome.reviews_word_one') ?? 'review')
          : (copyText('product-chrome.reviews_word_many') ?? 'reviews')}
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
        <ReviewStars rating={aggregate.value} />{' '}
        {copyFill(
          aggregate.count === 1
            ? 'product-chrome.reviews_count_line_one'
            : 'product-chrome.reviews_count_line_many',
          aggregate.count === 1
            ? '{average} out of 5, from {count} review.'
            : '{average} out of 5, from {count} reviews.',
          {average: aggregate.value.toFixed(1), count: aggregate.count},
        )}
      </p>
      {shopUrl ? (
        <p className="review-count-line">
          <a href={shopUrl} target="_blank" rel="noopener noreferrer">
            {copyText('product-chrome.reviews_read_link') ?? 'Read the reviews'}
          </a>
        </p>
      ) : null}
    </>
  );
}
