import {DISCORD_INVITE_URL, type CompanyIdentity} from '~/lib/company';

const STORE_NAME = 'OpenDrone';
const DEFAULT_LOCALE = 'en_US';
// Canonical SEO origin: what rel=canonical, og:url and JSON-LD point at.
// Google must index opendrone.be even while pages serve on other hosts
// (www.opendrone.store stays the checkout host), so canonicals must never
// be derived from the request origin.
export const SITE_ORIGIN = 'https://opendrone.be';

export const DEFAULT_SEO_DESCRIPTION =
  'Open Source drone electronics designed in Belgium.';

function stripHtml(value?: string | null) {
  if (!value) return '';

  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve an origin-relative path against the canonical origin. */
function absolutize(value?: string | null) {
  if (!value) return value;
  return value.startsWith('/') ? `${SITE_ORIGIN}${value}` : value;
}

function truncate(value: string, maxLength = 160) {
  if (value.length <= maxLength) return value;

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function buildPageTitle(title?: string | null) {
  return title ? `${title} | ${STORE_NAME}` : STORE_NAME;
}

export function buildMetaDescription(
  primary?: string | null,
  fallback = DEFAULT_SEO_DESCRIPTION,
) {
  const description = stripHtml(primary) || fallback;
  return truncate(description);
}

export type HreflangAlternate = {
  lang: string; // e.g. 'en', 'nl', 'x-default'
  href: string; // absolute or origin-relative URL
};

export function buildSeoMeta({
  title,
  description,
  image,
  type = 'website',
  robots,
  locale = DEFAULT_LOCALE,
  alternateLocales,
  canonical,
  url,
  hreflang,
}: {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  type?: 'website' | 'article' | 'product';
  robots?: string;
  locale?: string;
  alternateLocales?: string[];
  canonical?: string;
  /**
   * Full request URL (e.g. `request.url`). When provided, the helper
   * auto-emits `<link rel="canonical">` unless `canonical` is passed
   * explicitly.
   */
  url?: string;
  /**
   * Explicit hreflang alternates for i18n-aware pages. Callers should
   * include an `x-default` entry pointing at the canonical locale.
   */
  hreflang?: HreflangAlternate[];
}) {
  const resolvedTitle = buildPageTitle(title);
  const resolvedDescription = buildMetaDescription(description);

  const meta: Array<Record<string, string>> = [
    {title: resolvedTitle},
    {name: 'description', content: resolvedDescription},
    {property: 'og:site_name', content: STORE_NAME},
    {property: 'og:title', content: resolvedTitle},
    {property: 'og:description', content: resolvedDescription},
    {property: 'og:type', content: type},
    {property: 'og:locale', content: locale},
    {name: 'twitter:card', content: 'summary_large_image'},
    // PNG, not SVG: Facebook, LinkedIn, iMessage, Slack, Discord and X all
    // reject SVG OG images and render a blank preview. og:image must be an
    // absolute URL: scrapers don't resolve relative paths.
    {
      property: 'og:image',
      content: absolutize(image) || `${SITE_ORIGIN}/og-image.png`,
    },
    // Dimensions help crawlers lay out the card before the fetch finishes.
    // Only emitted for the known-size default; a custom product image has
    // unknown dimensions, so we let the crawler measure it.
    ...(image
      ? []
      : [
          {property: 'og:image:width', content: '1200'},
          {property: 'og:image:height', content: '630'},
        ]),
  ];

  for (const alt of alternateLocales || []) {
    meta.push({property: 'og:locale:alternate', content: alt});
  }

  // Canonical - either passed in or derived from the request URL. Strips
  // query + hash so `?foo=bar` variants don't splinter into many canonicals.
  let resolvedCanonical = canonical;
  if (!resolvedCanonical && url) {
    try {
      const parsed = new URL(url);
      resolvedCanonical = `${parsed.origin}${parsed.pathname}`;
    } catch {
      /* ignore malformed URL */
    }
  }
  if (resolvedCanonical) {
    meta.push({tagName: 'link', rel: 'canonical', href: resolvedCanonical});
    meta.push({property: 'og:url', content: resolvedCanonical});
  }

  if (hreflang?.length) {
    for (const alt of hreflang) {
      meta.push({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: alt.lang,
        href: alt.href,
      });
    }
  }

  if (robots) {
    meta.push({name: 'robots', content: robots});
  }

  return meta;
}

/**
 * schema.org Organization JSON-LD - emit in root Layout <head>. Identifies
 * the selling entity (Incutec BV) for search engines, not the OpenDrone
 * product brand. We deliberately omit `email`: scrapers harvest it from
 * JSON-LD as readily as from a mailto. Customers reach us via /support.
 */
export function buildOrgJsonLd(company: CompanyIdentity, siteUrl?: string) {
  const url = (siteUrl || SITE_ORIGIN).replace(/\/$/, '');
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: company.name,
    url,
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      url: `${url}/support`,
    },
    // Omit telephone until a real number is set - never leak the placeholder.
    ...(company.tel && company.tel !== '[pending]'
      ? {telephone: company.tel}
      : {}),
    address: {
      '@type': 'PostalAddress',
      streetAddress: company.address,
      addressCountry: 'BE',
    },
    identifier: [
      {'@type': 'PropertyValue', propertyID: 'KBO', value: company.kbo},
      {'@type': 'PropertyValue', propertyID: 'VAT', value: company.vat},
    ],
    brand: {
      '@type': 'Brand',
      name: STORE_NAME,
    },
    logo: `${url}/opendrone-wordmark-1200.png`,
    sameAs: [...ORG_PROFILES],
  };
}

/** Public profiles for Organization.sameAs. */
const ORG_PROFILES = ['https://github.com/OpenDrone-hw', DISCORD_INVITE_URL] as const;

/** The date a preorder price stops applying: the campaign end. */
export const CAMPAIGN_END_ISO = '2026-12-31';

/**
 * schema.org Product JSON-LD - emit on PDP. Drives Google rich-result
 * cards for product listings (price, availability, brand). Skipped when
 * the variant has no price (combined-listing parents) so we don't post
 * a malformed offer.
 */
type ProductJsonLdInput = {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  url: string;
  vendor?: string | null;
  sku?: string | null;
  gtin?: string | null;
  price?: {amount: string; currencyCode: string} | null;
  availableForSale: boolean;
  /** Pre-order product: an orderable offer becomes schema.org/PreOrder
   *  instead of InStock (sold-out stays OutOfStock either way). */
  preorder?: boolean;
  productHandle: string;
  /**
   * Star aggregate from the synced review metafields (app/lib/reviews.ts).
   * Only pass a value when count > 0 - a zero-review AggregateRating is
   * malformed structured data. Null/undefined skips the block entirely.
   */
  rating?: {value: number; count: number} | null;
};

export function buildProductJsonLd(input: ProductJsonLdInput) {
  const product: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.title,
    url: input.url,
    productID: input.productHandle,
  };
  if (input.description) {
    product.description = stripHtml(input.description).slice(0, 5000);
  }
  if (input.imageUrl) product.image = input.imageUrl;
  if (input.vendor) {
    product.brand = {'@type': 'Brand', name: input.vendor};
  }
  if (input.sku) product.sku = input.sku;
  if (input.gtin) product.gtin = input.gtin;
  if (input.rating && input.rating.count > 0) {
    product.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: input.rating.value,
      reviewCount: input.rating.count,
      bestRating: 5,
      worstRating: 1,
    };
  }
  if (input.price) {
    product.offers = {
      '@type': 'Offer',
      url: input.url,
      price: input.price.amount,
      priceCurrency: input.price.currencyCode,
      availability: !input.availableForSale
        ? 'https://schema.org/OutOfStock'
        : input.preorder
          ? 'https://schema.org/PreOrder'
          : 'https://schema.org/InStock',
      priceValidUntil: input.preorder ? CAMPAIGN_END_ISO : nextYearIso(),
      // The statutory 14-day EU withdrawal period, returned by post.
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'BE',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: 14,
        returnMethod: 'https://schema.org/ReturnByMail',
      },
    };
  }
  return product;
}

function nextYearIso(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/** schema.org BreadcrumbList for a page reached from `trail` (name, path). */
export function buildBreadcrumbJsonLd(trail: ReadonlyArray<{name: string; path: string}>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: `${SITE_ORIGIN}${crumb.path}`,
    })),
  };
}
