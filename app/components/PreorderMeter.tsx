import {barPercent, stepBarLabel, type StepBarView} from '~/lib/preorder-meter';
import {InfoHint} from './InfoHint';
import {copyText} from '~/lib/copy';

/** Batch progress stays visible; the price schedule opens on demand. */
export function StepBar({
  bar,
  prices = [],
  fundedLabel,
  batch,
}: {
  bar: StepBarView;
  prices?: Array<{
    key: string | number;
    text: string;
    range?: string;
    current: boolean;
  }>;
  fundedLabel?: string;
  /** The batch this counter counts toward ("batch 1", "the March 2027
   *  batch"), so the count never reads as another batch's. */
  batch?: string | null;
}) {
  const pct = barPercent(bar);
  const at = (units: number) => `${(units / bar.max) * 100}%`;
  // A paid batch's count is a cap ("213 of 250 left"), a funding target's a
  // goal ("37 / 250 target").
  const label =
    bar.funded && fundedLabel
      ? fundedLabel
      : stepBarLabel(bar, batch ?? null, (key) => copyText(`preorder.${key}`));
  return (
    <div className="step-bar" data-funded={bar.funded ? '' : undefined}>
      <div className="step-bar-summary">
        <span className="step-bar-label">{label}</span>
        {prices.length > 1 ? (
          <InfoHint label={copyText('preorder.price_steps') ?? 'Price steps'}>
            <ol className="step-price-list">
              {prices.map((price) => (
                <li
                  key={price.key}
                  aria-current={price.current ? 'step' : undefined}
                >
                  <span>{price.range}</span>
                  <strong>{price.text}</strong>
                  <span>
                    {price.current
                      ? (copyText('preorder.price_now') ?? 'Now')
                      : ''}
                  </span>
                </li>
              ))}
            </ol>
          </InfoHint>
        ) : null}
      </div>
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
          <span key={tick} className="step-bar-tick" style={{left: at(tick)}} />
        ))}
      </span>
    </div>
  );
}
