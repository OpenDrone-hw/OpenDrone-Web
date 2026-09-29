import {barPercent, type StepBarView} from '~/lib/preorder-meter';
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
  /** The batch this counter counts toward ("March 2027"), named when the
   *  buyer's batch is not the first one, so the count never reads as the
   *  first batch's. */
  batch?: string | null;
}) {
  const pct = barPercent(bar);
  const at = (units: number) => `${(units / bar.max) * 100}%`;
  const label =
    bar.funded && fundedLabel
      ? fundedLabel
      : batch
        ? `${bar.label} ${(copyText('preorder.ordered_for_batch') ?? 'ordered for the {batch} batch').replace('{batch}', batch)}`
        : `${bar.label} ${copyText('preorder.ordered') ?? 'ordered'}`;
  return (
    <div className="step-bar" data-funded={bar.funded ? '' : undefined}>
      <div className="step-bar-summary">
        <span className="step-bar-label">{label}</span>
        {prices.length > 1 ? (
          <InfoHint label={copyText('preorder.price_steps') ?? 'Price steps'}>
            <p>{copyText('preorder.price_steps_help')}</p>
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
