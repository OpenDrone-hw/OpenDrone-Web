import type {Route} from './+types/products._index';
import {useEffect, useMemo} from 'react';
import type {ReactNode} from 'react';
import {Form, Link, useLoaderData, useSearchParams} from 'react-router';
import {ProductItem, type ProductQuickAdd} from '~/components/ProductItem';
import type {StackOffer} from '~/components/StackQuickAdd';
import type {MoneyV2, ProductCardFragment} from '~/lib/product-shapes';
import {formatPrice, toCards} from '~/lib/catalog';
import {CAMPAIGN} from '~/lib/catalog-client';
import {buyUrl, commerceHandoff, type CommerceHandoff} from '~/lib/shop-links';
import {AddToCartButton} from '~/components/AddToCartButton';
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
  lineDisplayName,
  variantCartNote,
} from '~/lib/product-content';
import {useProductStatusResolver, useRoadmapStatusResolver} from '~/lib/coming-soon';
import {stackDiscountedPrice} from '~/lib/stack-discount';
import {Txt} from '~/components/Txt';
import {copyText, editAttrs} from '~/lib/copy';
import {shopifyImageUrl} from '~/lib/shopify-image';

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
  // The one fixed ship date of the campaign, the stack's paid batch, for
  // the build guide's note on what ships when.
  const stackShips =
    Object.values(CAMPAIGN.skus)
      .flatMap((entry) => entry.batches)
      .find((batch) => batch.paid && batch.ships?.trim())
      ?.ships?.trim() ?? null;
  return {
    products: toCards(catalog),
    commerceHandoff: commerceHandoff(catalog),
    term,
    stackShips,
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
/**
 * A term as search words: normalised, sizes joined, and the radio bands
 * buyers type ("868", "915 MHz", "900mhz") read as the spec tables' own
 * word for them, "sub-GHz".
 */
function termWords(term: string): string[] {
  return sizes(normalise(term))
    .replace(/\b(?:868|915|900)\s*(?:mhz)?\b/g, 'sub-ghz')
    .split(/\s+/)
    .filter(Boolean);
}
function matchesTerm(haystack: string, term: string): boolean {
  const words = termWords(term);
  if (!words.length) return true;
  const hay = sizes(normalise(haystack));
  return words.every((w) => hay.includes(w));
}

/** The words that name what a card is: its product, handle and family. */
function familyTextOf(product: ProductCardFragment): string {
  return sizes(
    normalise(
      [
        product.title,
        product.handle,
        product.productType,
        PRODUCT_CONTENT[product.handle]?.family,
      ]
        .filter(Boolean)
        .join(' '),
    ),
  );
}

/**
 * A search word that names a product family ("motor", "esc", "receiver")
 * keeps only the cards of that family: "5 inch motor" lists the 5" motor,
 * not the ESC whose spec table mentions a motor and a 5" frame. Words that
 * name no family (sizes, specs such as "BEC") narrow nothing.
 */
function narrowToFamily<T extends {title: string; product: ProductCardFragment}>(
  list: T[],
  term: string,
): T[] {
  const words = termWords(term);
  const familyWords = words.filter((w) => list.some((c) => familyTextOf(c.product).includes(w)));
  if (!familyWords.length) return list;
  return list.filter((c) => {
    const own = `${sizes(normalise(c.title))} ${familyTextOf(c.product)}`;
    return familyWords.every((w) => own.includes(w));
  });
}

/**
 * Searches for things this shop does not sell, or sizes it does not make,
 * get a plain answer above the results instead of a bare "Nothing found".
 * `surface` lists cards (`handle:option value`) worth showing when nothing
 * else matches. The texts live in content/copy/collections-all.json.
 */
const SEARCH_HELP: Array<{match: RegExp; copyId: string; surface?: string[]}> = [
  {
    match: /\b(?:whoops?|tinywhoops?|tiny|micro|1s|65\s*mm|75\s*mm|65mm|75mm)\b/,
    copyId: 'collections-all.help_whoop',
    surface: ['openrx:Lite'],
  },
  {
    match:
      /\b(?:goggles?|dji|o3|o4|avata|radio|remote|transmitter|walksnail|hdzero|vtx|camera|bind|binding|elrs|expresslrs|(?<!flight\s)controllers?)\b/,
    copyId: 'collections-all.help_video_radio',
  },
  {
    match: /\b(?:spares?|replacements?|repairs?|arms?|crash(?:ed|es)?|broken)\b/,
    copyId: 'collections-all.help_spare',
  },
  {
    match: /\b(?:gifts?|cadeaus?|cadeau|verjaardag|birthday|present|christmas|kerst|sinterklaas)\b/,
    copyId: 'collections-all.help_gift',
  },
  {
    match: /\b(?:[6-9]|1[0-9])\s*(?:inch|in)\b|\blong\s*range\b|\blr\b|cinelifter/,
    copyId: 'collections-all.help_size',
  },
  {match: /\bgps\b/, copyId: 'collections-all.help_gps'},
];

function searchHelpFor(term: string) {
  if (!term) return null;
  const t = sizes(normalise(term));
  return SEARCH_HELP.find((h) => h.match.test(t)) ?? null;
}

/**
 * How well a card answers the search term, lower is better: the card's own
 * name equal to the term, then every word in its name, then every word in
 * its handle or family, then a match on specs and keywords only. Searching
 * "OpenRX" or "receiver" lists the receivers before the flight controller
 * whose spec table mentions a receiver.
 */
function termRelevance(card: {title: string; product: ProductCardFragment}, term: string): number {
  const words = termWords(term);
  if (!words.length) return 0;
  const name = sizes(normalise(card.title));
  if (name === words.join(' ')) return 0;
  if (words.every((w) => name.includes(w))) return 1;
  const family = sizes(
    normalise(
      [
        card.product.title,
        card.product.handle,
        card.product.productType,
        PRODUCT_CONTENT[card.product.handle]?.family,
      ]
        .filter(Boolean)
        .join(' '),
    ),
  );
  if (words.every((w) => name.includes(w) || family.includes(w))) return 2;
  return 3;
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
  // Label and value both, so "BEC" or "telemetry" finds the boards that
  // list one. A row whose value is "None" is not a match for its label.
  return [...table.entries()].flatMap(([k, v]) =>
    v && !/^none$/i.test(v.trim()) ? [k, v] : [],
  );
}

/** What a card is searched on: names, family, firmware and spec rows. */
function searchTextFor(p: ProductCardFragment, value = ''): string {
  const content = PRODUCT_CONTENT[p.handle];
  const tier = value ? content?.variants?.[value] : undefined;
  // A labelled tier is searched by its label only: OpenMotor's option value
  // "2207" is a legacy key, not a size anyone should find it by.
  return [
    p.title,
    tier?.label ? '' : value,
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
  const {products, commerceHandoff, term, stackShips} = useLoaderData<typeof loader>();
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
    if (term) list = narrowToFamily(list.filter((c) => matchesTerm(c.searchText, term)), term);
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
    // With a search term and the default order, the best match leads and
    // the family order breaks ties (Array.sort is stable). A sort the buyer
    // picks (price, name, newest) is kept as picked.
    if (term && sort === 'featured') {
      const relevance = new Map(sorted.map((c) => [c.key, termRelevance(c, term)]));
      sorted.sort((a, b) => relevance.get(a.key)! - relevance.get(b.key)!);
    }
    return sorted;
  }, [cards, term, activeType, onlySale, activeBuild, activeFirmware, sort]);

  // A plain answer for searches the catalog cannot meet (whoop sizes,
  // goggles, 7 inch), and the cards worth showing when nothing matched.
  const help = searchHelpFor(term);
  const surfaced = useMemo(
    () =>
      help?.surface && visible.length === 0
        ? cards.filter((c) => help.surface!.includes(c.key))
        : [],
    [help, visible.length, cards],
  );
  const shown = visible.length > 0 ? visible : surfaced;

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
  const builds = useMemo(
    () =>
      resolveBuilds(
        products,
        commerceHandoff,
        (handle) => isPurchasableStatus(productStatus(handle)),
        (handle) => roadmapStatus(handle),
      ),
    [products, commerceHandoff, productStatus, roadmapStatus],
  );
  // Keep the active filters when a new term is submitted: the form only
  // carries `q`, so the rest ride along as hidden fields.
  const carried = ['type', 'sale', 'sort'].filter((k) => searchParams.get(k));

  return (
    <div className="collection page-shell">
      <header className="page-header collection-header">
        <Txt id="collections-all.eyebrow" as="p" className="page-eyebrow max-sm:hidden" />
        <Txt id="collections-all.title" as="h1" className="page-title" />
        {/* The two builds for a buyer who is new here, each jumping to its
            full card in the guide below. */}
        {hasProducts ? <BuildPicker builds={builds} /> : null}
        {/* The catalog is also the search page: the term filters the grid
            below, client-side over the catalog. Enter submits; the
            magnifier inside the field is the same submit for a pointer. */}
        {/* On a phone the header's search icon is the way in; the field
            shows here once a term is set, so the products sit higher. */}
        <Form
          method="get"
          action="/products"
          className={`catalog-search${term ? '' : ' max-sm:hidden'}`}
          role="search"
        >
          <div className="catalog-search-field">
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
            <button
              type="submit"
              className="catalog-search-submit"
              aria-label={copyText('collections-all.search_submit') ?? 'Search'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
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

            {help ? (
              <div className="catalog-search-help" role="note">
                <Txt id={help.copyId} as="p" />
              </div>
            ) : null}
            {shown.length > 0 ? (
              <div className="products-grid">
                {shown.map((card, index) => (
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
            ) : help ? null : term ? (
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
      {hasProducts ? (
        <BuildGuide
          builds={builds}
          stackShips={stackShips}
          onShowBuild={(id) => {
            const next = new URLSearchParams();
            next.set('build', id);
            setSearchParams(next, {preventScrollReset: false});
            if (typeof window !== 'undefined') window.scrollTo({top: 0, behavior: 'smooth'});
          }}
        />
      ) : null}
    </div>
  );
}

/** Each role as a plain noun, for the sentence under "Add the build". */
const ROLE_NOUN: Record<string, string> = {
  'flight-controller': 'flight controller',
  esc: 'ESC',
  frame: 'frame',
  motors: 'motors',
  receiver: 'receiver',
};

/** "a, b and c". */
function listJoin(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The build guide's order of parts, with the copy key that explains each. */
const GUIDE_ROLES: Array<{role: string; copyId: string}> = [
  {role: 'flight-controller', copyId: 'collections-all.guide_role_fc'},
  {role: 'esc', copyId: 'collections-all.guide_role_esc'},
  {role: 'frame', copyId: 'collections-all.guide_role_frame'},
  {role: 'motors', copyId: 'collections-all.guide_role_motors'},
  {role: 'receiver', copyId: 'collections-all.guide_role_receiver'},
];

/** The two parts of a build that make the stack: paid stock with its own
 *  ship date, orderable on their own ahead of the funding targets. */
const STACK_ROLES = new Set(['flight-controller', 'esc']);

/** The design stage of a funding-target part, in the words the product
 *  page uses (content/copy/product-chrome.json), so the two cannot drift. */
function stageLine(status: string | undefined): string | null {
  if (status === 'in-progress')
    return copyText('product-chrome.stage_in_progress') ?? 'Design stage: prototypes ordered, not yet tested';
  if (status === 'alpha')
    return copyText('product-chrome.stage_alpha') ?? 'Design stage: prototypes built and flown by testers';
  return null;
}

type ResolvedBuild = ReturnType<typeof resolveBuilds>[number];

/**
 * Every build of content/builds.json with its parts resolved against the
 * catalog: names, prices, ship tags and the one-click add links. The parts
 * come from builds.json and the names and prices from the catalog, so no
 * total is written by hand. A part the catalog lacks is skipped.
 */
function resolveBuilds(
  products: CatalogProduct[],
  commerceHandoff: CommerceHandoff,
  isBuyable: (handle: string) => boolean,
  roadmapStatus: (handle: string) => string | undefined,
) {
  return BUILDS.builds.map((build) => {
    const parts = GUIDE_ROLES.flatMap(({role, copyId}) => {
      const part = build.parts.find((p) => p.role === role);
      if (!part) return [];
      const handle = BUILDS.roles[part.role]?.handle;
      const product = products.find((p) => p.handle === handle);
      const variant = product?.variants.nodes.find((v) => v.sku === part.sku);
      if (!product || !variant) return [];
      const query = new URLSearchParams(
        variant.selectedOptions
          .filter((o) => o.value !== 'Default Title')
          .map((o): [string, string] => [o.name, o.value]),
      ).toString();
      const waits = Boolean(variant.campaign && !variant.campaign.paidStock);
      return [
        {
          role,
          copyId,
          name: lineDisplayName(product.handle, product.title, variant.title),
          to: `/products/${product.handle}${query ? `?${query}` : ''}`,
          quantity: part.quantity,
          price: variant.price,
          sku: variant.sku ?? '',
          image: variant.image ?? product.featuredImage ?? null,
          shipPromise: variant.shipPromise,
          // Paid stock carries its own ship date; anything else waits for
          // its funding target.
          tag: variant.campaign
            ? variant.campaign.paidStock && variant.shipPromise
              ? variant.shipPromise.replace(/^ships/, 'Ships')
              : (copyText('collections-all.guide_tag_target') ?? 'Funding target')
            : null,
          waits,
          // What is not final about this exact part (the 5" motor's stator
          // and KV), from the same product-content field as the cart line.
          note: variantCartNote(product.handle, variant.title),
          stage: waits ? stageLine(roadmapStatus(product.handle)) : null,
          buyable:
            Boolean(variant.availableForSale && variant.sku) && isBuyable(product.handle),
        },
      ];
    });
    const currency = parts[0]?.price.currencyCode ?? 'EUR';
    const sum = (list: typeof parts) =>
      list.reduce((total, p) => total + num(p.price) * p.quantity, 0);
    const total = sum(parts);
    // One add for the whole build, every line in one cart call, only when
    // every part of it can be ordered now.
    const complete = parts.length === build.parts.length && parts.every((p) => p.buyable);
    const addHref = complete
      ? buyUrl(
          commerceHandoff,
          parts.map((p) => ({sku: p.sku, quantity: p.quantity})),
        )
      : null;
    // The stack on its own: the paid-stock parts that ship first.
    const stack = parts.filter((p) => STACK_ROLES.has(p.role));
    const stackHref =
      stack.length === STACK_ROLES.size && stack.every((p) => p.buyable && !p.waits)
        ? buyUrl(
            commerceHandoff,
            stack.map((p) => ({sku: p.sku, quantity: p.quantity})),
          )
        : null;
    const waiting = parts.filter((p) => p.waits).map((p) => ROLE_NOUN[p.role] ?? p.role);
    const frame = parts.find((p) => p.role === 'frame');
    return {
      id: build.id,
      label: build.label,
      parts,
      total,
      currency,
      addHref,
      stackHref,
      stackTotal: sum(stack),
      stackShips: stack[0]?.shipPromise ?? null,
      waiting,
      image: frame?.image ?? parts[0]?.image ?? null,
    };
  });
}

/**
 * "New to FPV? Pick a build": one compact line under the page title with
 * the two builds, their totals and a thumbnail, each jumping to its full
 * card in the guide further down. It stands in for the help links, so the
 * first products stay above the fold on a small phone.
 */
function BuildPicker({builds}: {builds: ResolvedBuild[]}) {
  const shown = builds.filter((b) => b.parts.length);
  return (
    <div className="catalog-help-links flex flex-wrap items-center gap-x-3 gap-y-2 max-sm:gap-x-2">
      {/* One row on a 320px phone: a short label and the two sizes, so the
          first products stay above the fold. */}
      <Txt
        id="collections-all.picker_label"
        as="span"
        className="text-[14px] font-semibold text-[var(--color-text)] max-sm:hidden"
        fallback="New to FPV? Pick a build:"
      />
      <Txt
        id="collections-all.picker_label_short"
        as="span"
        className="text-[13px] font-semibold text-[var(--color-text)] sm:hidden"
        fallback="New to FPV?"
      />
      {shown.map((build) => (
        <a
          key={build.id}
          href={`#build-${build.id}`}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-[var(--r-pill)] border border-[var(--color-border)] bg-[var(--color-bg-card)] py-1 pl-1 pr-3 no-underline! hover:border-[var(--color-gold)] max-sm:pl-3"
        >
          {build.image?.url ? (
            <img
              src={shopifyImageUrl(build.image.url, 80)}
              alt=""
              width={36}
              height={36}
              loading="lazy"
              className="h-9 w-9 rounded-full bg-[var(--color-bg-elevated)] object-contain max-sm:hidden"
            />
          ) : null}
          <span className="text-[14px] font-semibold text-[var(--color-text)]">
            {/* "3-inch build" on a wide screen, "3-inch" on a phone so both
                builds fit on one line above the products. */}
            <span className="sm:hidden">{build.label}</span>
            <span className="max-sm:hidden">
              {(copyText('collections-all.guide_build_title') ?? '{label} build').replace(
                '{label}',
                build.label,
              )}
            </span>
          </span>
          <span className="font-mono text-[12px] text-[var(--color-text-muted)] max-sm:hidden">
            {formatPrice(build.total, build.currency)}
          </span>
        </a>
      ))}
      <Link
        prefetch="viewport"
        to="/roadmap"
        className="text-[13px] max-sm:hidden"
      >
        <Txt id="collections-all.roadmap_link" fallback="What the status labels mean" />
      </Link>
    </div>
  );
}

/**
 * "New to FPV? What you need for a build": for each build size in
 * content/builds.json, the parts one quad needs, each linked to its own
 * product option with the quantity and today's price, the stack on its own
 * as the first step, then what a build needs that this shop does not sell.
 */
function BuildGuide({
  builds,
  stackShips,
  onShowBuild,
}: {
  builds: ResolvedBuild[];
  stackShips: string | null;
  onShowBuild: (buildId: string) => void;
}) {
  // /products#coming-from-dji (home, support, search help) opens the
  // collapsed answer on arrival.
  useEffect(() => {
    const open = () => {
      if (window.location.hash !== '#coming-from-dji') return;
      const target = document.getElementById('coming-from-dji');
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
        target.scrollIntoView();
      }
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, []);
  if (!builds.some((b) => b.parts.length)) return null;
  const shipNote = stackShips
    ? (copyText('collections-all.guide_ships') ?? '').replace('{stack_ships}', stackShips)
    : '';

  return (
    <section
      id="new-to-fpv"
      className="mt-16 scroll-mt-28 border-t border-[var(--color-border)] pt-10"
    >
      <Txt id="collections-all.guide_eyebrow" as="p" className="page-eyebrow" />
      <Txt
        id="collections-all.guide_title"
        as="h2"
        className="font-display text-2xl md:text-3xl font-bold tracking-tight text-[var(--color-text)] mb-3"
      />
      <Txt
        id="collections-all.guide_lead"
        as="p"
        className="max-w-[46rem] text-[15px] leading-relaxed text-[var(--color-text-muted)] mb-8"
      />
      <div className="grid gap-5 md:grid-cols-2">
        {builds.map((build) =>
          build.parts.length ? (
            <div
              key={build.id}
              id={`build-${build.id}`}
              className="build-guide-card scroll-mt-28 rounded-[var(--r-md,12px)] border border-[var(--color-border)] bg-[var(--color-bg-card)] p-5 md:p-6"
            >
              <div className="flex items-baseline justify-between gap-3 mb-4">
                <h3 className="font-display text-lg font-bold text-[var(--color-text)]">
                  {(copyText('collections-all.guide_build_title') ?? '{label} build').replace(
                    '{label}',
                    build.label,
                  )}
                </h3>
                <span className="font-mono text-[12px] text-[var(--color-text-muted)] whitespace-nowrap">
                  {(copyText('collections-all.guide_total') ?? 'Parts: {price}').replace(
                    '{price}',
                    formatPrice(build.total, build.currency),
                  )}
                </span>
              </div>
              <ol className="flex flex-col">
                {build.parts.map((part, i) => (
                  <li
                    key={part.role}
                    className={`grid grid-cols-[1.75rem_1fr_auto] gap-x-3 py-3 ${
                      i > 0 ? 'border-t border-[var(--color-border)]' : ''
                    }`}
                  >
                    <span
                      className="font-mono text-[12px] text-[var(--color-gold-text)] pt-0.5"
                      aria-hidden="true"
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <Link
                        prefetch="intent"
                        to={part.to}
                        className="font-medium text-[var(--color-text)] underline decoration-[var(--color-border-strong)] underline-offset-4 hover:decoration-[var(--color-gold)]"
                      >
                        {part.quantity > 1 ? `${part.quantity} × ` : ''}
                        {part.name}
                      </Link>
                      {part.tag ? (
                        <span
                          className="build-guide-tag"
                          data-waits={part.waits ? '' : undefined}
                        >
                          {part.tag}
                        </span>
                      ) : null}
                      <Txt
                        id={part.copyId}
                        as="p"
                        className="mt-1 text-[13px] leading-snug text-[var(--color-text-muted)]"
                      />
                      {part.stage ? (
                        <p className="mt-1 text-[13px] leading-snug text-[var(--color-text-muted)]">
                          {part.stage}
                        </p>
                      ) : null}
                      {part.note ? (
                        <p className="mt-1 text-[13px] leading-snug text-[var(--color-gold-text)]">
                          {part.note}
                        </p>
                      ) : null}
                      {part.role === 'receiver' ? (
                        <Txt
                          id="collections-all.guide_receiver_swap"
                          as="p"
                          className="mt-1 text-[13px] leading-snug text-[var(--color-text-muted)]"
                        />
                      ) : null}
                    </div>
                    <span className="font-mono text-[13px] text-[var(--color-text)] whitespace-nowrap pt-0.5">
                      {part.quantity > 1
                        ? `${part.quantity} × ${formatPrice(part.price.amount, part.price.currencyCode)}`
                        : formatPrice(part.price.amount, part.price.currencyCode)}
                    </span>
                  </li>
                ))}
              </ol>
              {build.addHref || build.stackHref ? (
                <div className="build-guide-add flex flex-col gap-2">
                  {build.addHref ? (
                    <AddToCartButton
                      href={build.addHref}
                      product={build.parts[0]?.role === 'flight-controller' ? 'openfc-lite' : null}
                      revenue={{currency: build.currency, amount: build.total}}
                      className="btn-primary build-guide-add-btn"
                    >
                      {(copyText('collections-all.guide_add') ?? 'Add the {label} build · {price}')
                        .replace('{label}', build.label)
                        .replace('{price}', formatPrice(build.total, build.currency))}
                    </AddToCartButton>
                  ) : null}
                  {build.stackHref ? (
                    <AddToCartButton
                      href={build.stackHref}
                      product="openfc-lite"
                      revenue={{currency: build.currency, amount: build.stackTotal}}
                      className="btn-secondary build-guide-add-btn"
                    >
                      {(copyText('collections-all.guide_add_stack') ?? 'Start with the stack · {price} · {ships}')
                        .replace('{price}', formatPrice(build.stackTotal, build.currency))
                        .replace('{ships}', build.stackShips ?? '')
                        .replace(/\s·\s*$/, '')}
                    </AddToCartButton>
                  ) : null}
                  {build.waiting.length ? (
                    <p className="build-guide-add-note">
                      {(
                        copyText('collections-all.guide_add_waits') ??
                        'The {parts} are funding targets. Add them now and the whole parcel waits for them, or order the stack now and the rest later (shipping is paid again).'
                      ).replace('{parts}', listJoin(build.waiting))}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-5">
                <Txt
                  id="collections-all.guide_also_title"
                  as="h4"
                  className="font-display text-[15px] font-bold text-[var(--color-text)] mb-2"
                />
                <ul className="flex flex-col gap-1.5 text-[13px] leading-snug text-[var(--color-text-muted)]">
                  <Txt
                    id={`collections-all.guide_also_${build.id.replace(/[^a-z0-9]/gi, '')}`}
                    as="li"
                    className="relative pl-6 before:absolute before:left-0 before:top-0 before:font-mono before:text-[var(--color-gold-text)] before:content-['✓']"
                  />
                </ul>
              </div>
              <button
                type="button"
                onClick={() => onShowBuild(build.id)}
                className="mt-4 font-mono text-[12px] uppercase tracking-[0.15em] text-[var(--color-gold-text)] hover:text-[var(--color-gold-text-hover)] min-h-[44px]"
              >
                {(copyText('collections-all.guide_filter') ?? 'Show only {label} parts').replace(
                  '{label}',
                  build.label,
                )}
              </button>
            </div>
          ) : null,
        )}
      </div>
      <details
        id="coming-from-dji"
        className="build-guide-dji group mt-6 scroll-mt-28 text-[14px] leading-relaxed text-[var(--color-text-muted)]"
      >
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <Txt
            id="collections-all.guide_dji_title"
            as="span"
            className="font-display text-base font-bold text-[var(--color-text)]"
          />
          <span aria-hidden="true" className="font-mono text-[var(--color-gold-text)] transition-transform group-open:rotate-45">
            +
          </span>
        </summary>
        <div className="mt-2 flex max-w-[68ch] flex-col gap-2">
          <Txt id="collections-all.guide_dji_body" as="p" />
        </div>
      </details>
      <div className="mt-6 max-w-[46rem] text-[14px] leading-relaxed text-[var(--color-text-muted)]">
        <Txt
          id="collections-all.guide_when_title"
          as="h3"
          className="font-display text-base font-bold text-[var(--color-text)] mb-2"
        />
        {shipNote ? <p className="mb-2">{shipNote}</p> : null}
        <Txt id="collections-all.guide_when_body" as="p" />
      </div>
    </section>
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
