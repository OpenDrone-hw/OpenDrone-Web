import {useEffect, useId, useRef, useState} from 'react';
import {AUTOCOMPLETE, POSTCODE_COUNTRIES, postcodeFirst, postcodeKey} from '~/lib/commerce/address-fields';
import {MIN_CHARS, type Suggestion} from '~/lib/commerce/address-provider';
import type {ExpressResult} from '~/lib/commerce/payment-provider';

type Country = {code: string; name: string};
export type AddressFill = ExpressResult['address'] & {name?: string; phone?: string};

function Text({label, optional, className = '', ...rest}: {label: string; optional?: boolean; className?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={`co-field ${className}`}>
      <span>
        {label}
        {optional ? <em> (optional)</em> : null}
      </span>
      <input required={!optional} {...rest} />
    </label>
  );
}

/** The Delivery section: country, name, a street combobox with suggestions, postcode and city (order by country), phone. */
export function AddressFields({country, countries, suggest, onCountry, fill}: {
  country: string;
  countries: Country[];
  suggest: boolean;
  onCountry: (code: string) => void;
  fill: AddressFill | null;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [postal, setPostal] = useState('');
  const [city, setCity] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const cityTouched = useRef(false);

  useEffect(() => {
    if (!fill) return;
    if (fill.name) setName(fill.name);
    if (fill.phone) setPhone(fill.phone);
    setLine1(fill.line1);
    setLine2(fill.line2);
    setPostal(fill.postal_code);
    setCity(fill.city);
    cityTouched.current = true;
    if (fill.country && fill.country !== country && countries.some((c) => c.code === fill.country)) onCountry(fill.country);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill]);

  // Postcode to city for the countries with a static table; a city the visitor typed or picked is never overwritten.
  useEffect(() => {
    const key = postcodeKey(country, postal);
    if (!key || !POSTCODE_COUNTRIES.includes(country)) {
      setCities([]);
      return;
    }
    const ctl = new AbortController();
    fetch(`/shop/postcode?country=${country}&code=${encodeURIComponent(key)}`, {signal: ctl.signal})
      .then((r) => (r.ok ? (r.json() as Promise<{cities?: string[]}>) : {cities: []}))
      .then((b) => {
        const found = b.cities ?? [];
        setCities(found);
        if (found.length && !cityTouched.current) setCity(found[0]);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [country, postal]);

  const cityField = (
    <Text label="City" name="city" autoComplete={AUTOCOMPLETE.city} value={city} list={cities.length > 1 ? 'co-cities' : undefined}
      onChange={(e) => { cityTouched.current = e.target.value !== ''; setCity(e.target.value); }} />
  );
  const postalField = (
    <Text label="Postal code" name="postal_code" autoComplete={AUTOCOMPLETE.postal_code} value={postal}
      onChange={(e) => { if (city === '') cityTouched.current = false; setPostal(e.target.value); }} />
  );
  return (
    <>
      <label className="co-field">
        <span>Country</span>
        <select name="country" autoComplete={AUTOCOMPLETE.country} value={country} onChange={(e) => onCountry(e.target.value)}>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
      </label>
      <Text label="Full name" name="name" autoComplete={AUTOCOMPLETE.name} value={name} onChange={(e) => setName(e.target.value)} />
      <StreetCombobox country={country} enabled={suggest} value={line1} onChange={setLine1}
        onPick={(s) => { setLine1(s.line1); if (s.postal_code) setPostal(s.postal_code); setCity(s.city); cityTouched.current = true; }} />
      <Text label="Apartment, suite, etc." name="line2" autoComplete={AUTOCOMPLETE.line2} optional value={line2} onChange={(e) => setLine2(e.target.value)} />
      <div className={postcodeFirst(country) ? 'co-row' : 'co-row co-row-city-first'}>
        {postcodeFirst(country) ? <>{postalField}{cityField}</> : <>{cityField}{postalField}</>}
      </div>
      <datalist id="co-cities">{cities.map((c) => <option key={c} value={c} />)}</datalist>
      <Text label="Phone" name="phone" type="tel" autoComplete={AUTOCOMPLETE.phone} inputMode="tel" optional value={phone} onChange={(e) => setPhone(e.target.value)} />
    </>
  );
}

/** Street field as an ARIA 1.2 combobox: debounced lookups at /shop/address, arrows, Enter, Escape, live count. */
function StreetCombobox({country, enabled, value, onChange, onPick}: {
  country: string;
  enabled: boolean;
  value: string;
  onChange: (v: string) => void;
  onPick: (s: Suggestion) => void;
}) {
  const id = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef(false);

  useEffect(() => {
    if (!enabled || !typed.current || value.trim().length < MIN_CHARS) {
      setItems([]);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/shop/address?country=${country}&q=${encodeURIComponent(value.trim())}`, {signal: ctl.signal})
        .then((r) => (r.ok ? (r.json() as Promise<{suggestions?: Suggestion[]}>) : {suggestions: []}))
        .then((b) => {
          setItems(b.suggestions ?? []);
          setActive(-1);
          setOpen(true);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [value, country, enabled]);

  const choose = (s: Suggestion) => {
    typed.current = false;
    onPick(s);
    setOpen(false);
    setItems([]);
  };
  const shown = open && items.length > 0;
  return (
    <div className="co-field co-combo">
      <label htmlFor={`${id}-in`}>
        <span>Address</span>
      </label>
      <input
        id={`${id}-in`} name="line1" required autoComplete={AUTOCOMPLETE.line1} value={value}
        role={enabled ? 'combobox' : undefined} aria-autocomplete={enabled ? 'list' : undefined}
        aria-expanded={enabled ? shown : undefined} aria-controls={enabled ? `${id}-list` : undefined}
        aria-activedescendant={shown && active >= 0 ? `${id}-o${active}` : undefined}
        onChange={(e) => { typed.current = true; onChange(e.target.value); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={(e) => {
          if (!shown) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % items.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
          else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(items[active]); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {enabled ? (
        <>
          <ul id={`${id}-list`} role="listbox" aria-label="Address suggestions" className="co-suggest" hidden={!shown}>
            {items.map((s, i) => (
              <li key={s.label} id={`${id}-o${i}`} role="option" aria-selected={i === active} className="co-suggest-item"
                onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
                {s.label}
              </li>
            ))}
          </ul>
          <span className="co-sr" role="status" aria-live="polite">{shown ? `${items.length} suggestions, use up and down arrows` : ''}</span>
        </>
      ) : null}
    </div>
  );
}
