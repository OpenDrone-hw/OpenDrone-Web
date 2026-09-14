import {redirect, useLoaderData} from 'react-router';
import type {Route} from './+types/collections.$handle';
import {getPaginationVariables, Analytics} from '@shopify/hydrogen';
import {PaginatedResourceSection} from '~/components/PaginatedResourceSection';
import {redirectIfHandleIsLocalized} from '~/lib/redirect';
import {ProductItem} from '~/components/ProductItem';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
import {isConceptFor} from '~/lib/product-content';
import type {ProductItemFragment} from 'storefrontapi.generated';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {Breadcrumb} from '~/components/Breadcrumb';
import {CollectionSort, resolveSort} from '~/components/CollectionSort';
import {EmptyState} from '~/components/EmptyState';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

export const meta: Route.MetaFunction = ({data, location}) =>
  buildSeoMeta({
    title: data?.collection?.title
      ? `${data.collection.title} ${copyText('collections-handle.meta_title_suffix') ?? 'Collection'}`
      : (copyText('collections-handle.meta_title_fallback') ?? 'Collection'),
    description:
      data?.collection?.description ||
      copyText('collections-handle.meta_description') ||
      'Explore curated OpenDrone hardware collections and product families.',
    type: 'product',
    // Canonical without pagination/sort queries so variants don't splinter.
    url: `${SITE_ORIGIN}${location.pathname}`,
  });

export async function loader(args: Route.LoaderArgs) {
  // Start fetching non-critical data without blocking time to first byte
  const deferredData = loadDeferredData(args);

  // Await the critical data required to render initial state of the page
  const criticalData = await loadCriticalData(args);

  return {...deferredData, ...criticalData};
}

/**
 * Load data necessary for rendering content above the fold. This is the critical data
 * needed to render the page. If it's unavailable, the whole page should 400 or 500 error.
 */
async function loadCriticalData({context, params, request}: Route.LoaderArgs) {
  const {handle} = params;
  const {storefront} = context;
  const paginationVariables = getPaginationVariables(request, {
    pageBy: 12,
  });

  if (!handle) {
    throw redirect('/collections');
  }

  const url = new URL(request.url);
  const sort = resolveSort(url.searchParams.get('sort'));

  const [{collection}] = await Promise.all([
    storefront.query(COLLECTION_QUERY, {
      variables: {
        handle,
        ...paginationVariables,
        sortKey: sort.sortKey,
        reverse: Boolean(sort.reverse),
      },
      cache: storefront.CacheLong(),
    }),
  ]);

  if (!collection) {
    throw new Response(`Collection ${handle} not found`, {
      status: 404,
    });
  }

  // The API handle might be localized, so redirect to the localized handle
  redirectIfHandleIsLocalized(request, {handle, data: collection});

  return {
    collection,
  };
}

/**
 * Load data for rendering content below the fold. This data is deferred and will be
 * fetched after the initial page load. If it's unavailable, the page should still 200.
 * Make sure to not throw any errors here, as it will cause the page to 500.
 */
function loadDeferredData({context}: Route.LoaderArgs) {
  return {};
}

export default function Collection() {
  const {collection} = useLoaderData<typeof loader>();
  const roadmapStatus = useRoadmapStatusResolver();
  const hasProducts = collection.products.nodes.length > 0;

  return (
    <div className="collection page-shell">
      <Breadcrumb
        items={[
          {
            label: <Txt id="collections-handle.breadcrumb_shop" />,
            to: '/collections/all',
          },
          {label: collection.title},
        ]}
      />
      <header className="page-header collection-header">
        <div>
          <Txt id="collections-handle.eyebrow" as="p" className="page-eyebrow" />
          <h1 className="page-title">{collection.title}</h1>
          {collection.description ? (
            <p className="page-description">{collection.description}</p>
          ) : null}
        </div>
        {hasProducts && <CollectionSort />}
      </header>
      {hasProducts ? (
        <PaginatedResourceSection<ProductItemFragment>
          connection={collection.products}
          resourcesClassName="products-grid"
        >
          {({node: product, index}) =>
            // Concept products (planned / in-progress) never list.
            isConceptFor(product.handle, roadmapStatus(product.handle)) ? null : (
              <ProductItem
                key={product.id}
                product={product}
                loading={index < 8 ? 'eager' : undefined}
              />
            )
          }
        </PaginatedResourceSection>
      ) : (
        <EmptyState
          title={<Txt id="collections-handle.empty_title" />}
          description={<Txt id="collections-handle.empty_body" />}
          ctaLabel={<Txt id="collections-handle.empty_cta" />}
          ctaTo="/collections/all"
        />
      )}
      <Analytics.CollectionView
        data={{
          collection: {
            id: collection.id,
            handle: collection.handle,
          },
        }}
      />
    </div>
  );
}

const PRODUCT_ITEM_FRAGMENT = `#graphql
  fragment MoneyProductItem on MoneyV2 {
    amount
    currencyCode
  }
  fragment ProductItem on Product {
    id
    handle
    title
    featuredImage {
      id
      altText
      url
      width
      height
    }
    priceRange {
      minVariantPrice {
        ...MoneyProductItem
      }
      maxVariantPrice {
        ...MoneyProductItem
      }
    }
  }
` as const;

// NOTE: https://shopify.dev/docs/api/storefront/2022-04/objects/collection
const COLLECTION_QUERY = `#graphql
  ${PRODUCT_ITEM_FRAGMENT}
  query Collection(
    $handle: String!
    $country: CountryCode
    $language: LanguageCode
    $first: Int
    $last: Int
    $startCursor: String
    $endCursor: String
    $sortKey: ProductCollectionSortKeys
    $reverse: Boolean
  ) @inContext(country: $country, language: $language) {
    collection(handle: $handle) {
      id
      handle
      title
      description
      products(
        first: $first,
        last: $last,
        before: $startCursor,
        after: $endCursor,
        sortKey: $sortKey,
        reverse: $reverse
      ) {
        nodes {
          ...ProductItem
        }
        pageInfo {
          hasPreviousPage
          hasNextPage
          endCursor
          startCursor
        }
      }
    }
  }
` as const;
