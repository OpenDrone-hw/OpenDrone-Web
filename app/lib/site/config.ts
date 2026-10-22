/**
 * The site a request is served as (docs/sites.md in incutec-app, "How the storefront reads a site"): one Worker serves
 * many sites, chosen by hostname. `SiteConfig` is the part of the app's `storefront.site` answer this front uses, and
 * `defaultSite()` is the bundled opendrone.be built from today's constants: the answer whenever SITE_SOURCE is off or
 * the app cannot be asked and nothing is cached.
 */
import {PLAUSIBLE_SCRIPT_SRC} from '../growth/plausible.ts';

export const DEFAULT_SITE_NAME = 'OpenDrone';
export const DEFAULT_SITE_ORIGIN = 'https://opendrone.be';
export const DEFAULT_SEO_DESCRIPTION = 'Open Source drone electronics designed in Belgium.';

export type NavKind = 'page' | 'posts' | 'collection' | 'product' | 'link';
export type NavItem = {label: string; kind: NavKind; target?: string};
export type SitePageIndexEntry = {title: string; slug: string; kind: 'home' | 'page' | 'legal'; description?: string | null; seo_title?: string | null};

export type SiteConfig = {
  /** True when the app answered for this host; false for the bundled default. */
  fromApp: boolean;
  id: string | null;
  version: number | null;
  name: string;
  origin: string;
  locale: string;
  titleTemplate: string;
  description: string;
  /** False: pages answer `noindex,nofollow`. */
  indexable: boolean;
  /** Colour tokens by role, validated by the app; empty keeps the bundled design. */
  colours: Partial<Record<'canvas' | 'surface' | 'text' | 'muted' | 'accent' | 'line', string>>;
  /** Corner radius in px of the site's cards and controls (0 to 32); null keeps the bundled radii. */
  radius: number | null;
  /** https URLs of the site's favicon and default social image; null keeps the bundled files. */
  favicon: string | null;
  socialImage: string | null;
  /** Plausible domain of the site; null: the bundled opendrone.be script rules (request host check). */
  plausibleDomain: string | null;
  navigation: {header: NavItem[]; footer: NavItem[]};
  pages: SitePageIndexEntry[];
  /** The site's own text by copy id (`home.hero_line1`) over the bundled content/copy strings; {} for the default site. */
  texts: Record<string, string>;
};

export function defaultSite(): SiteConfig {
  return {
    fromApp: false,
    id: null,
    version: null,
    name: DEFAULT_SITE_NAME,
    origin: DEFAULT_SITE_ORIGIN,
    locale: 'en_US',
    titleTemplate: `%s | ${DEFAULT_SITE_NAME}`,
    description: DEFAULT_SEO_DESCRIPTION,
    indexable: true,
    colours: {},
    radius: null,
    favicon: null,
    socialImage: null,
    plausibleDomain: null,
    navigation: {header: [], footer: []},
    pages: [],
    texts: {},
  };
}

/** The `storefront.site` answer, as far as this front reads it. Every field may be missing from an older app. */
export type AppSiteAnswer = {
  site: string;
  version: number;
  name?: string | null;
  canonical?: string;
  locales?: string[] | null;
  theme?: {colours?: SiteConfig['colours'] | null; radius?: number | null; favicon?: string | null; social_image?: string | null} | null;
  navigation?: {header?: NavItem[] | null; footer?: NavItem[] | null} | null;
  seo?: {title_template?: string; description?: string; robots?: string} | null;
  analytics?: {plausible_domain?: string | null} | null;
  pages?: SitePageIndexEntry[] | null;
  texts?: Record<string, unknown> | null;
};

/** An absolute https URL, else null: a theme image never loads over http or from a relative or script address. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Only string values under string keys are kept; anything else would break a <Txt>. */
export function cleanTexts(texts: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(texts ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

export function siteFromAnswer(a: AppSiteAnswer): SiteConfig {
  const base = defaultSite();
  const name = a.name?.trim() || base.name;
  const lang = a.locales?.[0];
  return {
    fromApp: true,
    id: a.site,
    version: a.version,
    name,
    origin: (a.canonical || base.origin).replace(/\/+$/, ''),
    locale: lang ? lang.replace('-', '_') : base.locale,
    titleTemplate: a.seo?.title_template?.includes('%s') ? a.seo.title_template : `%s | ${name}`,
    description: a.seo?.description?.trim() || base.description,
    indexable: a.seo?.robots !== 'noindex',
    colours: a.theme?.colours ?? {},
    radius: typeof a.theme?.radius === 'number' && Number.isInteger(a.theme.radius) && a.theme.radius >= 0 && a.theme.radius <= 32 ? a.theme.radius : null,
    favicon: httpsUrl(a.theme?.favicon),
    socialImage: httpsUrl(a.theme?.social_image),
    plausibleDomain: a.analytics?.plausible_domain || null,
    navigation: {header: a.navigation?.header ?? [], footer: a.navigation?.footer ?? []},
    pages: a.pages ?? [],
    texts: cleanTexts(a.texts),
  };
}

/** The route a navigation item opens: page /<slug>, posts the news archive, collection and product their routes. */
export function navHref(item: NavItem): string {
  const t = (item.target ?? '').trim();
  switch (item.kind) {
    case 'page':
      return `/${t.replace(/^\/+/, '')}`;
    case 'posts':
      return '/newsletter';
    case 'collection':
      return `/collections/${encodeURIComponent(t)}`;
    case 'product':
      return `/products/${encodeURIComponent(t)}`;
    default:
      return t;
  }
}

export type NavLinkData = {id: string; title: string; url: string};

/** The menus the root loader hands the chrome (`site` in the root loader data); null keeps the bundled menu. */
export type SiteNav = {headerNav?: NavLinkData[] | null; footerNav?: NavLinkData[] | null; name?: string};

/** Items as links; null when the site has none for this menu, so the bundled menu stays. Unsafe link schemes are dropped. */
export function navLinks(items: NavItem[], menu: string): NavLinkData[] | null {
  const out = items
    .map((it, i) => ({id: `site-${menu}-${i}`, title: it.label, url: navHref(it)}))
    .filter((l) => l.url && (l.url.startsWith('/') || /^https:\/\//i.test(l.url)));
  return out.length ? out : null;
}

const TOKENS: Record<keyof SiteConfig['colours'], string> = {
  canvas: '--color-bg',
  surface: '--color-surface',
  text: '--color-text',
  muted: '--color-text-muted',
  accent: '--color-accent',
  line: '--color-border',
};

/** The site's colours as overrides of the existing --color-* mapping (the app already checked each is a colour;
 *  anything that could leave the declaration is dropped again here). Feed it to buildThemeCss. */
export function themeOverrides(colours: SiteConfig['colours'], radius: number | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  // One radius from the Studio scales the three bundled steps (4, 6, 10 px at the default 10).
  if (radius !== null) Object.assign(out, {'--r-md': `${radius}px`, '--r-sm': `${Math.round(radius * 0.6)}px`, '--r-xs': `${Math.round(radius * 0.4)}px`});
  for (const [role, token] of Object.entries(TOKENS)) {
    const v = colours[role as keyof SiteConfig['colours']];
    if (typeof v === 'string' && /^[#a-zA-Z0-9(),.%\s/-]+$/.test(v)) out[token] = v.trim();
  }
  return out;
}

/** Plausible for a site with its own domain: the generic script; the bundled site keeps its own script id. */
export function plausibleScript(site: Pick<SiteConfig, 'plausibleDomain'>): {src: string; domain: string | null} {
  return site.plausibleDomain
    ? {src: 'https://plausible.io/js/script.js', domain: site.plausibleDomain}
    : {src: PLAUSIBLE_SCRIPT_SRC, domain: null};
}
