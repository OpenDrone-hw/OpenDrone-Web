import {Link} from 'react-router';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {stepCounter, type TourProduct, type TourStep} from '~/lib/home-tour';

function Arrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

/**
 * One walkthrough step as the caption shows it: counter, the part's role, what
 * it does, and the product line when the shop sells that part. Shared by the
 * desktop caption panel, its no-3D list and the phone walkthrough.
 */
export function TourCaption({
  step,
  index,
  total,
  product,
  as: Heading = 'h2',
}: {
  step: TourStep;
  index: number;
  total: number;
  /** The shop's product for this step, or undefined when none is sold. */
  product?: TourProduct;
  as?: 'h2' | 'h3';
}) {
  const fill = (key: string, token: string, value: string) =>
    (copyText(`home.${key}`) ?? '').replace(token, value);
  return (
    <>
      <p className="tour-count">{stepCounter(index, total)}</p>
      <Heading className="tour-role">{step.title}</Heading>
      {step.caption ? <p className="tour-text">{step.caption}</p> : null}
      {product && step.handle ? (
        <div className="tour-product">
          <p className="tour-product-line">
            <span className="tour-product-name">{product.title}</span>
            {product.price ? (
              <span className="tour-product-price">
                {fill('tour_from', '{price}', product.price)}
                {product.unit ? ` ${product.unit}` : ''}
              </span>
            ) : null}
          </p>
          <Link className="tour-product-link" to={`/products/${step.handle}`} prefetch="intent">
            {fill('tour_view', '{name}', product.title)}
            <Arrow />
          </Link>
        </div>
      ) : null}
    </>
  );
}

/** The one Shop button of the walkthrough: quiet until the last step. */
export function TourShop({primary, className = ''}: {primary: boolean; className?: string}) {
  return (
    <Link
      prefetch="viewport"
      to="/collections/all"
      className={`${primary ? 'btn-primary tour-shop is-primary' : 'tour-shop'} ${className}`.trim()}
    >
      <Txt id="home.shop" />
      <Arrow />
    </Link>
  );
}
