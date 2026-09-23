import {barPercent, type StepBarView} from '~/lib/preorder-meter';

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
}: {
  bar: StepBarView;
  prices?: Array<{key: string | number; text: string; range?: string; current: boolean}>;
  fundedLabel?: string;
}) {
  const pct = barPercent(bar);
  const label = bar.funded && fundedLabel ? fundedLabel : bar.label;
  return (
    <div className="step-bar" data-funded={bar.funded ? '' : undefined}>
      {prices.length > 1 ? (
        <ol className="step-bar-prices">
          {prices.map((p) => (
            <li key={p.key} aria-current={p.current ? 'true' : undefined}>
              {p.text}
              {p.range ? <span className="step-bar-range">{p.range}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <span
        className="step-bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={bar.max}
        aria-valuenow={bar.value}
        aria-valuetext={label}
      >
        <span className="step-bar-fill" style={{width: `${pct}%`}} />
        {bar.ticks.map((tick) => (
          <span key={tick} className="step-bar-tick" style={{left: `${(tick / bar.max) * 100}%`}} />
        ))}
      </span>
      <span className="step-bar-label">{label}</span>
    </div>
  );
}
