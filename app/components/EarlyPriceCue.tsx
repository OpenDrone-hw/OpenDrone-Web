import type {EarlyPrice} from '~/lib/product-shapes';
import {formatPrice} from '~/lib/catalog';
import {copyText} from '~/lib/copy';

const text = (id: string, fallback: string) => copyText(`preorder.${id}`) ?? fallback;
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));

/*
 * A preorder step price is shown as a staircase: every step from the
 * early bird price up to retail, with the buyer's step lit. The retail
 * price is a later price, never a struck-through former one (Directive
 * 98/6/EC art. 6a: a preorder price was never a reduction).
 */

/** Three treads climbing to the right, the lit one gold. */
export function StairGlyph({lit = 0, count = 3}: {lit?: number; count?: number}) {
  const w = 6;
  const h = 4;
  const treads = Array.from({length: count}, (_, i) => i);
  const top = (i: number) => (count - 1 - i) * h + 1;
  const outline = treads
    .map((i) => `${i === 0 ? 'M' : 'L'}${i * w} ${top(i)} H${(i + 1) * w}`)
    .join(' ');
  return (
    <svg
      className="stair-glyph"
      viewBox={`0 0 ${count * w} ${count * h + 1}`}
      width={count * w}
      height={count * h + 1}
      aria-hidden="true"
    >
      <path d={outline} />
      <path className="stair-glyph-lit" d={`M${lit * w} ${top(lit)} H${(lit + 1) * w}`} />
    </svg>
  );
}

/** The product page staircase: each step's price, the buyer's step lit with
 *  the units left on it, retail as the top step. */
export function EarlyPriceSteps({early}: {early: EarlyPrice | null | undefined}) {
  if (!early) return null;
  if (!early.steps.length) return <EarlyPriceTag />;
  const n = early.steps.length;
  const price = (m: {amount: string; currencyCode: string}) => formatPrice(m.amount, m.currencyCode);
  const current = early.steps.find((s) => s.current);
  const label = fill(text('early_steps_label', 'Price steps: {steps}. You are on the {price} step, {count} left.'), {
    steps: early.steps.map((s) => price(s.price)).join(', '),
    price: current ? price(current.price) : '',
    count: early.left,
  });
  const currentIndex = early.steps.findIndex((s) => s.current);
  return (
    <div className="early-steps" role="img" aria-label={label}>
      {early.steps.map((step, i) => {
        const state = i < currentIndex ? 'gone' : step.current ? 'current' : 'next';
        const retail = i === n - 1;
        return (
          <div
            key={i}
            className="early-step"
            data-state={state}
            style={{'--rise': `${(i + 1) / n}`} as React.CSSProperties}
          >
            <span className="early-step-head">
              {step.current
                ? text('early_label', 'Early bird')
                : retail
                  ? text('early_retail', 'Retail')
                  : null}
            </span>
            <span className="early-step-tread">
              {step.current ? (
                <span className="early-step-left">
                  {fill(text('early_left', '{count} left'), {count: early.left})}
                </span>
              ) : null}
            </span>
            <span className="early-step-price">
              {step.approx ? '~' : ''}
              {price(step.price)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The compact mark for cards and cart lines: stair glyph, "Early bird",
 *  and on cards the retail price it climbs to. */
export function EarlyPriceCue({early}: {early: EarlyPrice | null | undefined}) {
  if (!early) return null;
  const lit = Math.max(0, early.steps.findIndex((s) => s.current));
  return (
    <span className="early-cue">
      <span className="early-cue-tag">
        <StairGlyph lit={lit} count={Math.max(early.steps.length, 2)} />
        {text('early_label', 'Early bird')}
      </span>
      {early.retail ? (
        <span className="early-cue-retail">
          {fill(text('early_retail_price', '{price} at retail'), {
            price: formatPrice(early.retail.amount, early.retail.currencyCode),
          })}
        </span>
      ) : null}
    </span>
  );
}

/** A cart line's mark: the line sells at an early bird price. */
export function EarlyPriceTag() {
  return (
    <span className="early-cue">
      <span className="early-cue-tag">
        <StairGlyph />
        {text('early_price', 'Early bird price')}
      </span>
    </span>
  );
}
