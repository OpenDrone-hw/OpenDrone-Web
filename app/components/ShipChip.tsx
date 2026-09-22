import {copyText} from '~/lib/copy';
import {shortShipPromise} from '~/lib/product-content';

/**
 * One short ship line for a cart or dialog row: "Funding target · ships by
 * 11 March 2027 if reached", or "Ships late October 2026". The full
 * funding-target condition is stated once per surface, not on every row.
 */
export function ShipChip({
  promise,
  className = 'cart-line-preorder',
  labelOnly = false,
}: {
  promise: string | null | undefined;
  className?: string;
  /** Compact rows: a funding target shows its label alone; the date is in
   *  the terms line of the same surface. */
  labelOnly?: boolean;
}) {
  const short = shortShipPromise(promise);
  if (!short) return null;
  return (
    <small className={`ship-chip ${className}`} data-kind={short.kind}>
      {short.label ? (
        <>
          <span className="ship-chip-label">
            {copyText('cart.ship_label_target') ?? short.label}
          </span>
          {labelOnly ? null : ' · '}
        </>
      ) : null}
      {short.label && labelOnly ? null : short.text}
    </small>
  );
}
