import {TRACK_SHARE, barPercent, type StepBarView} from '~/lib/preorder-meter';

/**
 * Units sold as one bar: the fill is units sold, a tick marks each price-step
 * end inside the bar, the label is "37 / 250" (or `fundedLabel` once a
 * target is reached). `prices` is the step price row above the bar, the
 * current step marked; a step's `range` ("1-100") prints under its price.
 */
export function StepBar({
  bar,
  prices = [],
  fundedLabel,
  layout = null,
}: {
  bar: StepBarView;
  prices?: Array<{key: string | number; text: string; range?: string; current: boolean}>;
  fundedLabel?: string;
  /** From `stepLayout`: each price placed over its own stretch of the bar,
   *  and a tail after the bar for a step past its end. */
  layout?: {lefts: number[]; tail: boolean} | null;
}) {
  const share = layout?.tail ? TRACK_SHARE : 1;
  const pct = barPercent(bar) * share;
  const at = (units: number) => `${(units / bar.max) * share * 100}%`;
  const label = bar.funded && fundedLabel ? fundedLabel : bar.label;
  const placed = layout && layout.lefts.length === prices.length;
  return (
    <div className="step-bar" data-funded={bar.funded ? '' : undefined}>
      {prices.length > 1 ? (
        <ol className={`step-bar-prices${placed ? ' is-placed' : ''}`}>
          {prices.map((p, i) => (
            <li
              key={p.key}
              aria-current={p.current ? 'true' : undefined}
              style={placed ? {left: `${layout.lefts[i]}%`} : undefined}
            >
              {p.text}
              {p.range ? <span className="step-bar-range">{p.range}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <span
        className="step-bar-track"
        data-tail={layout?.tail ? '' : undefined}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={bar.max}
        aria-valuenow={bar.value}
        aria-valuetext={label}
      >
        <span className="step-bar-fill" style={{width: `${pct}%`}} />
        {bar.ticks.map((tick) => (
          <span key={tick} className="step-bar-tick" style={{left: at(tick)}} />
        ))}
        {layout?.tail ? <span className="step-bar-tick" style={{left: at(bar.max)}} /> : null}
      </span>
      <span className="step-bar-label">{label}</span>
    </div>
  );
}
