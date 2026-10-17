import {data, useLoaderData} from 'react-router';
import type {Route} from './+types/shop.news.$handle';
import {type AppPost, AppUnavailable, edgeCache, requireAppCommerce, snapshot} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';

export const meta: Route.MetaFunction = ({data: d}) => [{title: d?.post?.title ?? 'News'}, {name: 'robots', content: 'noindex, nofollow'}];

export async function loader({context, params}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  let posts: AppPost[];
  try {
    posts = (await snapshot<{posts: AppPost[]}>(context.env, 'storefront.posts', edgeCache())).posts;
  } catch (err) {
    if (err instanceof AppUnavailable) throw data('News cannot be reached right now.', {status: 503});
    throw err;
  }
  const post = posts.find((p) => p.handle === params.handle);
  if (!post) throw new Response('Not found', {status: 404});
  return {post};
}

export default function ShopNewsPost() {
  const {post} = useLoaderData<typeof loader>();
  return (
    <ShopFrame title={post.title}>
      <p>
        {post.published_at.slice(0, 10)}
        {post.author ? `, ${post.author}` : ''}
      </p>
      {post.image ? <img src={post.image.url} alt={post.image.alt} className="w-full" /> : null}
      <article dangerouslySetInnerHTML={{__html: post.content_html}} />
    </ShopFrame>
  );
}
