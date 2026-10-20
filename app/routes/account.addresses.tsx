import {data, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/account.addresses';
import {addressRoute, clearSession, readAccount, requireAppAccounts} from '~/lib/commerce/app-account';
import {appOp, edgeCache, snapshot, type AppCatalog, type Quote} from '~/lib/commerce/app-api';
import {AccountAddresses} from '~/components/commerce/account/AccountPages';

export const meta: Route.MetaFunction = () => [{title: 'Addresses'}, {name: 'robots', content: 'noindex, nofollow'}];

/** The countries the shop delivers to (the checkout's own list), so a saved address can be used at checkout. */
async function shipCountries(env: Route.LoaderArgs['context']['env']): Promise<string[]> {
  try {
    // The app lists the countries with any quote, so price one unit of the first variant for the list.
    const cat = await snapshot<AppCatalog>(env, 'storefront.catalog', edgeCache());
    const variant = cat.products.flatMap((p) => p.variants).find((v) => v.available)?.id;
    if (!variant) return ['BE'];
    const out = await appOp<Quote>(env, 'storefront.quote', {lines: [{variant, qty: 1}], country: 'BE'});
    return out.data?.ship_countries?.length ? out.data.ship_countries : ['BE'];
  } catch {
    return ['BE'];
  }
}

export async function loader({request, context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  const {account, clear} = await readAccount(request, context.env);
  const headers = new Headers({'Cache-Control': 'no-store'});
  if (clear) headers.append('Set-Cookie', await clearSession(context.env));
  if (!account) throw redirect('/account/login?return_to=%2Faccount%2Faddresses', {headers});
  return data({account, countries: await shipCountries(context.env)}, {headers});
}

export async function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return addressRoute(request, context.env);
}

export default function AccountAddressesRoute() {
  const {account, countries} = useLoaderData<typeof loader>();
  return <AccountAddresses account={account} countries={countries} />;
}
