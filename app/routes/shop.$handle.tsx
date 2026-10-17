import {Form, data, redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/shop.$handle';
import {
  type AppCatalog,
  AppUnavailable,
  edgeCache,
  formatMoney,
  readCart,
  requireAppCommerce,
  snapshot,
  writeCart,
} from '~/lib/commerce/app-api';
import {ShopFrame} from '~/components/commerce/ShopFrame';

export const meta: Route.MetaFunction = ({data: d}) => [
  {title: d?.product?.seo.title || d?.product?.title || 'Shop'},
  {name: 'robots', content: 'noindex, nofollow'},
];

export async function loader({context, params}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  let catalog: AppCatalog;
  try {
    catalog = await snapshot<AppCatalog>(context.env, 'storefront.catalog', edgeCache());
  } catch (err) {
    if (err instanceof AppUnavailable) throw data('The shop cannot be reached right now.', {status: 503});
    throw err;
  }
  const product = catalog.products.find((p) => p.handle === params.handle);
  if (!product) throw new Response('Not found', {status: 404});
  return {product, currency: catalog.currency};
}

export async function action({context, request}: Route.ActionArgs) {
  requireAppCommerce(context.env);
  const form = await request.formData();
  const variant = String(form.get('variant') ?? '');
  const qty = Number(form.get('qty') ?? 1);
  const lines = await readCart(request, context.env);
  lines.push({variant, qty: Number.isInteger(qty) ? qty : 1});
  return redirect('/shop/cart', {headers: {'Set-Cookie': await writeCart(lines, context.env)}});
}

export default function ShopProduct() {
  const {product, currency} = useLoaderData<typeof loader>();
  const first = product.variants.find((v) => v.available) ?? product.variants[0];
  return (
    <ShopFrame title={product.title}>
      <div className="grid gap-8 md:grid-cols-2">
        {product.image ? <img src={product.image.url} alt={product.image.alt} className="w-full" /> : <div />}
        <div>
          <div dangerouslySetInnerHTML={{__html: product.description_html}} />
          <Form method="post" className="mt-6 grid gap-3">
            <label className="grid gap-1">
              <span>Option</span>
              <select name="variant" defaultValue={first?.id} className="border p-2">
                {product.variants.map((v) => (
                  <option key={v.id} value={v.id} disabled={!v.available}>
                    {v.title} {formatMoney(v.price_minor, currency)}
                    {v.available ? '' : ' (not available)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span>Quantity</span>
              <input name="qty" type="number" min={1} max={20} defaultValue={1} className="border p-2" />
            </label>
            <button type="submit" className="border px-4 py-2 font-semibold" disabled={!first?.available}>
              Add to cart
            </button>
          </Form>
        </div>
      </div>
    </ShopFrame>
  );
}
