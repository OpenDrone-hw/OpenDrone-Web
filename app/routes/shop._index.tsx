import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/shop._index';
import {type AppCatalog, AppUnavailable, edgeCache, formatMoney, requireAppCommerce, snapshot} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';

export const meta: Route.MetaFunction = () => [{title: 'Shop'}, {name: 'robots', content: 'noindex, nofollow'}];

export async function loader({context}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  try {
    return {catalog: await snapshot<AppCatalog>(context.env, 'storefront.catalog', edgeCache()), down: false};
  } catch (err) {
    if (err instanceof AppUnavailable) return {catalog: null, down: true};
    throw err;
  }
}

export default function ShopIndex() {
  const {catalog, down} = useLoaderData<typeof loader>();
  return (
    <ShopFrame title="Shop">
      {down || !catalog ? (
        <p>The shop cannot be reached right now. Try again in a minute.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.products.map((p) => {
            const from = Math.min(...p.variants.map((v) => v.price_minor ?? Infinity));
            return (
              <li key={p.id}>
                <Link to={`/shop/${p.handle}`} className="block">
                  {p.image ? <img src={p.image.url} alt={p.image.alt} loading="lazy" className="aspect-square w-full object-cover" /> : null}
                  <h2 className="mt-2 font-semibold">{p.title}</h2>
                  {Number.isFinite(from) ? <p>{formatMoney(from, catalog.currency)}</p> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </ShopFrame>
  );
}
