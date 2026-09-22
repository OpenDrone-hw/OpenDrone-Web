import type {Route} from './+types/products._index';
import {useMemo} from 'react';
import type {ReactNode} from 'react';
import {Form, Link, useLoaderData, useSearchParams} from 'react-router';
import {ProductItem, type ProductQuickAdd} from '~/components/ProductItem';
import type {StackOffer} from '~/components/StackQuickAdd';
import type {MoneyV2, ProductCardFragment} from '~/lib/product-shapes';
import {toCards} from '~/lib/catalog';
import {buyUrl, commerceHandoff} from '~/lib/shop-links';
import {FAMILIES} from '~/lib/families';
import {buildOf, parseBuilds} from '~/lib/build-recommendations';
import buildsJson from '../../content/builds.json';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {EmptyState} from '~/components/EmptyState';
import {
  PRODUCT_CONTENT,
  hiddenWhileSoldOut,
  isConceptFor,
  isPurchasableStatus,
} from '~/lib/product-content';
import {useProductStatusResolver, useRoadmapStatusResolver} from '~/lib/coming-soon';
import {stackDiscountedPrice} from '~/lib/stack-discount';
import {Txt} from '~/components/Txt';
import {copyText, editAttrs} from '~/lib/copy';

/**
 * The term-bearing meta string carries a `{term}` token rather than being
 * assembled from fragments, so the whole sentence stays editable as one.
 */
function withTerm(id: string, fallback: string, term: string): string {
  return (copyText(id) ?? fallback).replace('{term}', term);
}

export const meta: Route.MetaFunction = ({data, location}) =>
  buildSeoMeta({
    title: data?.term
      ? withTerm(
          'collections-all.meta_title_term',
          'Search results for "{term}"',
          data.term,
        )
      : copyText('collections-all.meta_title') ?? 'All Products',
    description:
      copyText('collections-all.meta_description') ??
      'Browse every OpenDrone product in one place: Open Source flight controllers, ESCs, receivers, frames, bundles, and accessories. Filter by category and sort by price or newest.',
    type: 'product',
    // Canonical without filter/sort/search queries so variants don't splinter.
    url: `${SITE_ORIGIN}${location.pathname}`,
    // A search result set is not a page worth indexing.
    robots: data?.term ? 'noindex,follow' : undefined,
  });

/**
 * Sidebar order for the known families (app/lib/families.ts, shared with
 * the header chips), then the two catch-all buckets. A family present in
 * the catalog but not listed here labels itself at the end of the rail, so
 * nothing is silently dropped. The family is catalog data; only the
 * heading is copy.
 */
const CATEGORY_ORDER: Array<{type: string; copyId: string}> = [
  ...FAMILIES.map((f) => ({type: f.type, copyId: f.copyId})),
  {type: 'Bundle', copyId: 'collections-all.category_bundle'},
  {type: 'Accessory', copyId: 'collections-all.category_accessory'},
];

/** Sort options for the toolbar dropdown. `featured` is the default: the
 *  families in sidebar order (boards first, accessories last), newest first
 *  inside each. `newest` is the loader's CREATED_AT-desc fetch order.
 *  `label` is the fallback for a missing copy key. */
const SORT_OPTIONS: Array<{value: string; copyId: string; label: string}> = [
  {value: 'featured', copyId: 'collections-all.sort_featured', label: 'Featured'},
  {value: 'newest', copyId: 'collections-all.sort_newest', label: 'Newest'},
  {value: 'price-asc', copyId: 'collections-all.sort_price_asc', label: 'Price: low to high'},
  {value: 'price-desc', copyId: 'collections-all.sort_price_desc', label: 'Price: high to low'},
  {value: 'name-asc', copyId: 'collections-all.sort_name_asc', label: 'Name: A–Z'},
  {value: 'name-desc', copyId: 'collections-all.sort_name_desc', label: 'Name: Z–A'},
];

export async function loader({request, context}: Route.LoaderArgs) {
  const term = String(new URL(request.url).searchParams.get('q') || '').trim();
  // The catalog is one small JSON document; the whole of it renders here
  // and the URL filters/sorts it client-side, so the page is one
  // shareable browse hub that lists every model on its own card. The
  // search term filters the same cards.
  const catalog = await context.catalog.get();
  return {
    products: toCards(catalog),
    commerceHandoff: commerceHandoff(catalog),
    term,
  };
}

type CatalogProduct = ProductCardFragment;

/** One browse card - a single product, or one model/tier of a product line. */
type Card = {
  key: string;
  product: CatalogProduct;
  title: string;
  /** What the search box matches against: title, tier, handle, type. */
  searchText: string;
  to: string;
  price: MoneyV2;
  /** `price` is the cheapest of several variant prices: the card says "from". */
  priceFrom?: boolean;
  /** The tier's own variant image, so each size card shows its real board
   *  instead of falling back to the product's featuredImage. */
  image?: CatalogProduct['featuredImage'];
  onSale: boolean;
  /** A product line whose every tier is still coming soon - shown as a
   *  greyed, non-clickable teaser rather than a buyable card. */
  comingSoon?: boolean;
  /** Hover quick-add: this card's own hand-off link. */
  quickAdd?: ProductQuickAdd;
  /** Stack offers layered on the quick-add (FC/ESC cards only). */
  stackOffers?: StackOffer[];
  /** Build size from content/builds.json ('3-inch', '5-inch'), or null
   *  for a part that fits both. */
  build: string | null;
  /** The open firmware project the board runs, if any. */
  firmware: string | null;
};

const num = (m?: MoneyV2 | null) => (m ? parseFloat(m.amount) || 0 : 0);

/** A product is "on sale" when any of its variants has a compare price. */
const productOnSale = (p: CatalogProduct) =>
  p.variants.nodes.some((v) => v.compareAtPrice != null);

/** The Shopify variant carrying a given option value (e.g. Model = "Gemini"),
 *  so a tier card shows its real price/sale even though the tiers themselves
 *  come from the editorial source of truth. */
function variantFor(p: CatalogProduct, axis: string, value: string) {
  const a = axis.trim().toLowerCase();
  const val = value.trim().toLowerCase();
  return p.variants.nodes.find((v) =>
    v.selectedOptions.some(
      (o) =>
        o.name.trim().toLowerCase() === a &&
        o.value.trim().toLowerCase() === val,
    ),
  );
}

/**
 * Join a product title with a tier value without stuttering - "OpenFC Lite" +
 * "20×20" → "OpenFC Lite 20×20", while "OpenRX" + "Gemini" → "OpenRX Gemini"
 * and "OpenFC Lite" + "Lite" → "OpenFC Lite" (drops the repeated word).
 */
function joinTitle(title: string, value: string): string {
  const tWords = title.split(/\s+/);
  const vWords = value.split(/\s+/);
  let i = 0;
  while (
    i < vWords.length &&
    tWords.length > 0 &&
    tWords[tWords.length - 1].toLowerCase() === vWords[i].toLowerCase()
  ) {
    tWords.pop();
    i++;
  }
  const rest = vWords.slice(i).join(' ');
  return rest ? `${title} ${rest}` : title;
}

/** Case- and accent-insensitive token match: every word of the term must
 *  occur somewhere in the card's searchable text. */
function normalise(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // Mount patterns: "20×20", "20 x 20" and "30.5 x 30.5" all read as
      // "20x20" / "30x30", the way buyers type them.
      .replace(/(\d+)(?:\.5)?\s*[x×]\s*(\d+)(?:\.5)?/g, '$1x$2')
  );
}
const BUILDS = parseBuilds(buildsJson);

function firmwareOf(handle: string): string | null {
  const project = PRODUCT_CONTENT[handle]?.firmware?.project;
  return project && project !== '-' ? project : null;
}

/** `5"`, `5 inch`, `5-inch` and `5in` all read as `5inch`. */
function sizes(s: string): string {
  return s.replace(/(\d)\s*-?\s*(?:"|”|inch(?:es)?\b|in\b)/g, '$1inch');
}
function matchesTerm(haystack: string, term: string): boolean {
  const words = sizes(normalise(term)).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = sizes(normalise(haystack));
  return words.every((w) => hay.includes(w));
}

/** A tier's spec values: the shared table with the tier's rows replacing
 *  (or, when null, removing) the shared row of the same key, so a 20x20 card
 *  does not match on the 30x30 board's mount pattern. */
function tierSpecValues(
  base: Array<[string, string]>,
  overrides: Array<[string, string | null]> | undefined,
): string[] {
  const table = new Map<string, string | null>(base);
  for (const [k, v] of overrides ?? []) table.set(k, v);
  return [...table.values()].filter((v): v is string => Boolean(v));
}

/** What a card is searched on: names, family, firmware and spec values. */
function searchTextFor(p: ProductCardFragment, value = ''): string {
  const content = PRODUCT_CONTENT[p.handle];
  const tier = value ? content?.variants?.[value] : undefined;
  return [
    p.title,
    value,
    tier?.label,
    p.handle,
    p.productType,
    content?.family,
    content?.firmware?.project,
    ...(content?.keywords ?? []),
    ...(tier?.keywords ?? []),
    ...tierSpecValues(content?.specs ?? [], tier?.specs),
  ]
    .filter(Boolean)
    .join(' ');
}

export default function ProductsIndex() {
  const {products, commerceHandoff, term} = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeType = searchParams.get('type');
  const onlySale = searchParams.get('sale') === '1';
  const activeBuild = searchParams.get('build');
  const activeFirmware = searchParams.get('firmware');
  const sort = searchParams.get('sort') || 'featured';

  // Expand each product into one card per purchasable model (skipping
  // coming-soon tiers); single products / bundles / accessories get one card.
  // Products arrive newest-first, so card order is newest-first by default.
  const productStatus = useProductStatusResolver();
  const roadmapStatus = useRoadmapStatusResolver();
  const cards = useMemo<Card[]>(() => {
    const out: Card[] = [];
    for (const p of products) {
      // Planned / in-progress products have no settled tiers or renders to
      // list; they live on /roadmap and their concept plate only.
      if (isConceptFor(p.handle, roadmapStatus(p.handle))) continue;
      // Resold parts that cannot be bought yet stay off the grid.
      if (hiddenWhileSoldOut(p)) continue;
      const content = PRODUCT_CONTENT[p.handle];
      const axis = content?.optionAxis;
      const allTiers =
        axis && content?.variants ? Object.entries(content.variants) : [];
      const liveTiers = allTiers.filter(([, v]) => !v.comingSoon);
      if (axis && liveTiers.length > 0) {
        for (const [value] of liveTiers) {
          const sv = variantFor(p, axis, value);
          const price = sv?.price ?? p.priceRange.minVariantPrice;
          // "Buy it as a stack" offers for FC/ESC tier cards: the partner
          // board at the same mount size, both lines prewired.
          const stackOffers: StackOffer[] = (
            content?.stack?.partners ?? []
          ).flatMap((pc) => {
            // Unlaunched partners can't join a stack offer (their price
            // stays hidden everywhere).
            if (!isPurchasableStatus(productStatus(pc.handle))) return [];
            const partner = products.find((pp) => pp.handle === pc.handle);
            if (!partner || !sv) return [];
            const pv = variantFor(
              partner,
              content?.stack?.matchOption ?? 'Model',
              value,
            );
            if (!pv) return [];
            // A pair discount is claimed only while Shopify carries the
            // matching discount (stack.discountPct is unset otherwise).
            const pct = content?.stack?.discountPct;
            const partnerDiscounted =
              Boolean(pct) &&
              content?.stack?.discountedHandle === pc.handle;
            const selfDiscounted =
              Boolean(pct) && content?.stack?.discountedHandle === p.handle;
            return [
              {
                key: pc.handle,
                label: pc.label ?? partner.title,
                size: value,
                price:
                  partnerDiscounted && pct
                    ? stackDiscountedPrice(pv.price, pct)
                    : pv.price,
                compareAtPrice: partnerDiscounted ? pv.price : null,
                pct,
                discountedLabel: selfDiscounted ? p.title : undefined,
                product: p.handle,
                available: Boolean(
                  pv.availableForSale && sv.availableForSale,
                ),
                href: buyUrl(commerceHandoff, [
                  {sku: sv.sku ?? '', quantity: 1},
                  {sku: pv.sku ?? '', quantity: 1},
                ]),
              },
            ];
          });
          out.push({
            key: `${p.handle}:${value}`,
            product: p,
            title: joinTitle(p.title, content?.variants?.[value]?.label ?? value),
            searchText: searchTextFor(p, value),
            build: buildOf(BUILDS, sv?.sku),
            firmware: firmwareOf(p.handle),
            to: `/products/${p.handle}?${encodeURIComponent(axis)}=${encodeURIComponent(value)}`,
            price,
            image: sv?.image ?? p.featuredImage,
            onSale: sv?.compareAtPrice
              ? num(sv.compareAtPrice) > num(price)
              : productOnSale(p),
            quickAdd: sv
              ? {
                  href: sv.cartAddUrl,
                  available: Boolean(sv.availableForSale),
                }
              : undefined,
            stackOffers,
          });
        }
      } else {
        // A line whose every tier is still coming soon (e.g. OpenFC) is an
        // unreleased teaser - show it greyed and non-clickable, not buyable.
        const comingSoon = allTiers.length > 0;
        // Quick-add only when there is genuinely ONE variant - a future
        // multi-option accessory must send the buyer to the PDP to choose.
        const firstVariant =
          p.variants.nodes.length === 1 ? p.variants.nodes[0] : undefined;
        out.push({
          key: p.handle,
          product: p,
          title: p.title,
          searchText: searchTextFor(p),
          build: null,
          firmware: firmwareOf(p.handle),
          to: `/products/${p.handle}`,
          price: p.priceRange.minVariantPrice,
          priceFrom:
            num(p.priceRange.maxVariantPrice) > num(p.priceRange.minVariantPrice),
          onSale: comingSoon ? false : productOnSale(p),
          comingSoon,
          quickAdd:
            !comingSoon && firstVariant
              ? {
                  href: firstVariant.cartAddUrl,
                  available: Boolean(firstVariant.availableForSale),
                }
              : undefined,
        });
      }
    }
    return out;
  }, [products, productStatus, roadmapStatus, commerceHandoff]);

  // Categories that hold at least one shown card, in editorial order then
  // any leftovers. Counting the cards, not the raw catalog, keeps a family
  // whose every product is hidden (unsellable, sold out) out of the rail.
  const categories = useMemo(() => {
    const present = new Set(cards.map((c) => c.product.productType || 'Other'));
    const out: Array<{value: string; label: ReactNode}> = CATEGORY_ORDER.filter(
      (c) => present.has(c.type),
    ).map((c) => ({
      value: c.type,
      label: <Txt id={c.copyId} />,
    }));
    for (const type of present) {
      if (!CATEGORY_ORDER.some((c) => c.type === type)) {
        // An unlisted family labels itself; only the "Other" catch-all is
        // our own word.
        out.push({
          value: type,
          label:
            type === 'Other' ? <Txt id="collections-all.category_other" /> : type,
        });
      }
    }
    return out;
  }, [cards]);

  const anyOnSale = useMemo(() => cards.some((c) => c.onSale), [cards]);
  const firmwares = useMemo(
    () => [...new Set(cards.map((c) => c.firmware).filter((f): f is string => Boolean(f)))],
    [cards],
  );

  // Filter (search term, category, sale), then sort. `newest` keeps the
  // loader's fetch order.
  const visible = useMemo(() => {
    let list = cards;
    if (term) list = list.filter((c) => matchesTerm(c.searchText, term));
    if (activeType)
      list = list.filter((c) => (c.product.productType || 'Other') === activeType);
    if (onlySale) list = list.filter((c) => c.onSale);
    // A size-neutral part (receiver, accessory) fits either build.
    if (activeBuild) list = list.filter((c) => c.build === null || c.build === activeBuild);
    if (activeFirmware) list = list.filter((c) => c.firmware === activeFirmware);
    const sorted = [...list];
    switch (sort) {
      case 'price-asc':
        sorted.sort((a, b) => num(a.price) - num(b.price));
        break;
      case 'price-desc':
        sorted.sort((a, b) => num(b.price) - num(a.price));
        break;
      case 'name-asc':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'name-desc':
        sorted.sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'newest':
        break; // already CREATED_AT desc from the loader
      default: {
        const rank = (c: (typeof sorted)[number]) => {
          const i = CATEGORY_ORDER.findIndex((o) => o.type === (c.product.productType || 'Other'));
          return i === -1 ? CATEGORY_ORDER.length : i;
        };
        sorted.sort((a, b) => rank(a) - rank(b));
      }
    }
    return sorted;
  }, [cards, term, activeType, onlySale, activeBuild, activeFirmware, sort]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    ['cursor', 'direction'].forEach((k) => next.delete(k));
    setSearchParams(next, {preventScrollReset: true});
  };

  const filterLink = (
    key: string,
    label: ReactNode,
    active: boolean,
    onClick: () => void,
  ) => (
    <li key={key}>
      <button
        type="button"
        className={`catalog-filter${active ? ' is-active' : ''}`}
        aria-pressed={active}
        onClick={onClick}
      >
        {label}
      </button>
    </li>
  );

  const hasProducts = products.length > 0;
  // Keep the active filters when a new term is submitted: the form only
  // carries `q`, so the rest ride along as hidden fields.
  const carried = ['type', 'sale', 'sort'].filter((k) => searchParams.get(k));

  return (
    <div className="collection page-shell">
      <header className="page-header collection-header">
        <Txt id="collections-all.eyebrow" as="p" className="page-eyebrow" />
        <Txt id="collections-all.title" as="h1" className="page-title" />
        {/* The catalog is also the search page: the term filters the grid
            below, client-side over the catalog. */}
        <Form method="get" action="/products" className="catalog-search">
          <div className="search-form-row catalog-search-row">
              {carried.map((k) => (
                <input
                  key={k}
                  type="hidden"
                  name={k}
                  value={searchParams.get(k) ?? ''}
                />
              ))}
              <input
                className="search-input"
                key={term}
                defaultValue={term}
                name="q"
                placeholder={copyText('collections-all.search_placeholder')}
                aria-label={copyText('collections-all.search_placeholder')}
                type="search"
                enterKeyHint="search"
                {...editAttrs('collections-all.search_placeholder')}
              />
              <Txt
                id="collections-all.search_submit"
                as="button"
                className="search-submit"
                type="submit"
              />
              {/* Every card carries its roadmap status chip; the roadmap is
                  where the vocabulary is explained, one button, beside the
                  search box. */}
              <Link
                prefetch="viewport"
                to="/roadmap"
                className="catalog-roadmap-btn"
              >
                <Txt
                  id="collections-all.roadmap_link"
                  fallback="What the status labels mean →"
                />
              </Link>
          </div>
        </Form>
      </header>

      {hasProducts ? (
        <div className="catalog-layout">
          {/* Left filter rail - category single-select + an on-sale toggle. */}
          <aside
            className="catalog-sidebar"
            aria-label={copyText('collections-all.filter_aria') ?? 'Filter products'}
          >
            <div className="catalog-filter-group">
              <Txt
                id="collections-all.filter_heading"
                as="h2"
                className="catalog-filter-head"
              />
              <ul className="catalog-filter-list">
                {filterLink(
                  'all',
                  <Txt id="collections-all.filter_all" />,
                  !activeType && !onlySale && !activeBuild && !activeFirmware,
                  () => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('type');
                    next.delete('sale');
                    next.delete('build');
                    next.delete('firmware');
                    setSearchParams(next, {preventScrollReset: true});
                  },
                )}
                {anyOnSale &&
                  filterLink(
                    'on-sale',
                    <Txt id="collections-all.filter_on_sale" />,
                    onlySale,
                    () => setParam('sale', onlySale ? null : '1'),
                  )}
                {categories.map((c) =>
                  filterLink(c.value, c.label, activeType === c.value, () =>
                    setParam('type', activeType === c.value ? null : c.value),
                  ),
                )}
              </ul>
            </div>
            <div className="catalog-filter-group">
              <Txt id="collections-all.filter_build" as="h2" className="catalog-filter-head" />
              <ul className="catalog-filter-list">
                {BUILDS.builds.map((b) =>
                  filterLink(`build-${b.id}`, b.label, activeBuild === b.id, () =>
                    setParam('build', activeBuild === b.id ? null : b.id),
                  ),
                )}
              </ul>
            </div>
            {firmwares.length > 1 ? (
              <div className="catalog-filter-group">
                <Txt id="collections-all.filter_firmware" as="h2" className="catalog-filter-head" />
                <ul className="catalog-filter-list">
                  {firmwares.map((f) =>
                    filterLink(`fw-${f}`, f, activeFirmware === f, () =>
                      setParam('firmware', activeFirmware === f ? null : f),
                    ),
                  )}
                </ul>
              </div>
            ) : null}
          </aside>

          {/* Main column - toolbar (count + sort) above the product grid. */}
          <div className="catalog-main">
            <div className="catalog-toolbar">
              <p className="catalog-count">
                {visible.length}{' '}
                <Txt
                  id={
                    visible.length === 1
                      ? 'collections-all.count_one'
                      : 'collections-all.count_other'
                  }
                />
                {term ? (
                  <>
                    {' '}
                    <Txt id="collections-all.count_for_term" as="span" />{' '}
                    <q className="catalog-term">{term}</q>{' '}
                    <button
                      type="button"
                      className="catalog-term-clear"
                      onClick={() => setParam('q', null)}
                    >
                      <Txt id="collections-all.search_clear" />
                    </button>
                  </>
                ) : null}
              </p>
              <label className="collection-sort catalog-sort">
                <span
                  className="collection-sort-label"
                  {...editAttrs('collections-all.sort_label')}
                >
                  {copyText('collections-all.sort_label') ?? 'Sort'}
                </span>
                <select
                  value={sort}
                  onChange={(e) =>
                    setParam('sort', e.target.value === 'featured' ? null : e.target.value)
                  }
                >
                  {SORT_OPTIONS.map((o) => (
                    // A <select> may only contain text in its options, so
                    // these read the string instead of rendering <Txt>.
                    <option
                      key={o.value}
                      value={o.value}
                      {...editAttrs(o.copyId)}
                    >
                      {copyText(o.copyId) ?? o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {visible.length > 0 ? (
              <div className="products-grid">
                {visible.map((card, index) => (
                  <ProductItem
                    key={card.key}
                    product={card.product}
                    to={card.to}
                    title={card.title}
                    priceOverride={card.price}
                    priceFrom={card.priceFrom ?? false}
                    imageOverride={card.image}
                    loading={index < 4 ? 'eager' : undefined}
                    imageSizes="(min-width: 64em) 300px, (min-width: 45em) 33vw, 50vw"
                    onSale={card.onSale}
                    comingSoon={card.comingSoon}
                    quickAdd={card.quickAdd}
                    stackOffers={card.stackOffers}
                  />
                ))}
              </div>
            ) : term ? (
              <EmptyState
                title={<Txt id="collections-all.empty_search_title" />}
                description={<Txt id="collections-all.empty_search_body" />}
                ctaLabel={<Txt id="collections-all.empty_filters_cta" />}
                ctaTo="/products"
              />
            ) : (
              <EmptyState
                title={<Txt id="collections-all.empty_filters_title" />}
                description={<Txt id="collections-all.empty_filters_body" />}
                ctaLabel={<Txt id="collections-all.empty_filters_cta" />}
                ctaTo="/products"
              />
            )}
          </div>
        </div>
      ) : (
        <EmptyState
          title={<Txt id="collections-all.empty_catalog_title" />}
          description={<Txt id="collections-all.empty_catalog_body" />}
          secondary={
            <a
              href="https://github.com/OpenDrone-hw"
              target="_blank"
              rel="noopener noreferrer"
              className="hero-cta-secondary"
            >
              <Txt id="collections-all.empty_catalog_secondary" />
            </a>
          }
        />
      )}
    </div>
  );
}

/** Pages and articles for the search term. Products are matched against
 *  the catalog cards client-side, so search() is only asked for the rest. */
const SITE_SEARCH_QUERY = `#graphql
  query CatalogSiteSearch(
    $country: CountryCode
    $language: LanguageCode
    $term: String!
    $first: Int
  ) @inContext(country: $country, language: $language) {
    articles: search(query: $term, types: [ARTICLE], first: $first) {
      nodes {
        ... on Article {
          __typename
          handle
          id
          title
          trackingParameters
          blog {
            handle
          }
        }
      }
    }
    pages: search(query: $term, types: [PAGE], first: $first) {
      nodes {
        ... on Page {
          __typename
          handle
          id
          title
          trackingParameters
        }
      }
    }
  }
` as const;

const COLLECTION_ITEM_FRAGMENT = `#graphql
  fragment MoneyCollectionItem on MoneyV2 {
    amount
    currencyCode
  }
  fragment CollectionItem on Product {
    id
    handle
    title
    productType
    createdAt
    featuredImage {
      id
      altText
      url
      width
      height
    }
    priceRange {
      minVariantPrice {
        ...MoneyCollectionItem
      }
      maxVariantPrice {
        ...MoneyCollectionItem
      }
    }
    compareAtPriceRange {
      minVariantPrice {
        ...MoneyCollectionItem
      }
    }
    variants(first: 50) {
      nodes {
        id
        availableForSale
        image {
          id
          altText
          url
          width
          height
        }
        selectedOptions {
          name
          value
        }
        price {
          ...MoneyCollectionItem
        }
        compareAtPrice {
          ...MoneyCollectionItem
        }
      }
    }
  }
` as const;

const CATALOG_QUERY = `#graphql
  query Catalog(
    $country: CountryCode
    $language: LanguageCode
    $first: Int
  ) @inContext(country: $country, language: $language) {
    products(
      first: $first
      sortKey: CREATED_AT
      reverse: true
      # The legacy firmware-donation tip product is not catalog.
      query: "-product_type:Donation"
    ) {
      nodes {
        ...CollectionItem
      }
    }
  }
  ${COLLECTION_ITEM_FRAGMENT}
` as const;
