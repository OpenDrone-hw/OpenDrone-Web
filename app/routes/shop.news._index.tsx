import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/shop.news._index';
import {type AppPost, AppUnavailable, edgeCache, requireAppCommerce, snapshot} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';

export const meta: Route.MetaFunction = () => [{title: 'News'}, {name: 'robots', content: 'noindex, nofollow'}];

export async function loader({context}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  try {
    return {posts: (await snapshot<{posts: AppPost[]}>(context.env, 'storefront.posts', edgeCache())).posts};
  } catch (err) {
    if (err instanceof AppUnavailable) return {posts: [] as AppPost[]};
    throw err;
  }
}

export default function ShopNews() {
  const {posts} = useLoaderData<typeof loader>();
  return (
    <ShopFrame title="News">
      <ul className="grid gap-4">
        {posts.map((p) => (
          <li key={p.handle}>
            <Link to={`/shop/news/${p.handle}`} className="font-semibold">
              {p.title}
            </Link>
            <p>{p.published_at.slice(0, 10)}</p>
            {p.excerpt ? <p>{p.excerpt}</p> : null}
          </li>
        ))}
      </ul>
    </ShopFrame>
  );
}
