import type {Route} from './+types/shop.postcode';
import {requireAppCommerce} from '~/lib/commerce/app-api';
import {postcodeKey} from '~/lib/commerce/address-fields';

// One lazy chunk per country (GeoNames postal codes, CC BY 4.0; scripts/build-postcodes.mjs).
const tables = import.meta.glob<Record<string, string[]>>('../data/postcodes/*.json', {import: 'default'});

/** GET /shop/postcode?country=BE&code=1000: {cities: [...]} (empty when unknown or the country has no table). */
export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const url = new URL(request.url);
  const country = (url.searchParams.get('country') ?? '').toUpperCase();
  const key = postcodeKey(country, url.searchParams.get('code') ?? '');
  const load = /^[A-Z]{2}$/.test(country) ? tables[`../data/postcodes/${country}.json`] : undefined;
  const cities = key && load ? ((await load())[key] ?? []) : [];
  return Response.json({cities}, {headers: {'Cache-Control': 'public, max-age=86400', 'X-Robots-Tag': 'noindex'}});
}
