import {useLocation, useNavigate, useNavigation} from 'react-router';
import {useEffect, useState} from 'react';
import type {MappedProductOptions} from '~/lib/product-shapes';
import {trackEvent} from '~/lib/growth/plausible';
import {attributionProps} from '~/lib/growth/attribution';

/**
 * One option axis as compact chips, for the pinned buy bar: names only, no
 * prices. The buy module's own option pills are hidden there, so a product
 * with a second axis (OpenMotor's 4S or 6S) would otherwise let a buyer
 * pre-order from the bar without seeing which one is selected. Uses the
 * ladder's chip classes so the bar styles both alike.
 */
export function OptionChips({
  option,
  order,
  product,
}: {
  option: MappedProductOptions;
  /** Display order of the values; unlisted values follow in catalog order. */
  order?: string[];
  product: string;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (navigation.state === 'idle') setPending(null);
  }, [navigation.state, location.search]);

  const norm = (s: string) => s.trim().toLowerCase();
  const wanted = order?.map(norm) ?? [];
  const rank = (name: string) => {
    const i = wanted.indexOf(norm(name));
    return i < 0 ? wanted.length : i;
  };
  const values = option.optionValues
    .filter((v) => v.exists)
    .sort((a, b) => rank(a.name) - rank(b.name));
  if (values.length < 2) return null;

  return (
    <div className="variant-ladder" role="radiogroup" aria-label={option.name}>
      <div className="variant-ladder-track">
        {values.map((value) => (
          <button
            type="button"
            key={value.name}
            role="radio"
            aria-checked={value.selected}
            className={`variant-tier${value.selected ? ' is-selected' : ''}${
              !value.available ? ' is-soldout' : ''
            }${pending === value.name ? ' is-pending' : ''}`}
            onClick={() => {
              if (value.selected) return;
              setPending(value.name);
              trackEvent('Variant Select', {
                props: {product, variant: value.name, ...attributionProps()},
              });
              void navigate(`?${value.variantUriQuery}`, {replace: true, preventScrollReset: true});
            }}
          >
            {value.selected ? <span className="variant-tier-glow" aria-hidden="true" /> : null}
            <span className="variant-tier-head">
              <span className="variant-tier-name">{value.name}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
