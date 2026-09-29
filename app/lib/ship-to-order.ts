import {EU_COUNTRIES, type ShipCountryOption} from './shipping-rates.ts';

/**
 * The Ship to list in three groups: the pinned ones (the usual destinations
 * and the United States while it is sold direct), the other EU countries,
 * then every other country. Each group keeps the order it came in, by name.
 */
export function groupShipCountries(picker: {likely: ShipCountryOption[]; rest: ShipCountryOption[]}): {
  pinned: ShipCountryOption[];
  eu: ShipCountryOption[];
  world: ShipCountryOption[];
} {
  const us = picker.rest.find((o) => o.code === 'US' && o.rate !== null);
  const pinned = us ? [...picker.likely, us] : [...picker.likely];
  const others = picker.rest.filter((o) => o !== us);
  return {
    pinned,
    eu: others.filter((o) => EU_COUNTRIES.has(o.code)),
    world: others.filter((o) => !EU_COUNTRIES.has(o.code)),
  };
}
