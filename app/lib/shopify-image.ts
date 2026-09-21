/**
 * Resized Shopify CDN images. cdn.shopify.com serves any width and WebP from
 * the original file through `width` and `format` query parameters; other
 * URLs (local assets, renders) pass through unchanged.
 *
 * Bundler-free so node:test can load it.
 */

const WIDTHS = [160, 320, 480, 640, 960, 1280, 1600] as const;

function isShopifyCdn(url: string): boolean {
  try {
    return new URL(url).hostname === 'cdn.shopify.com';
  } catch {
    return false;
  }
}

/** The URL of `url` at `width` CSS pixels, WebP, or `url` itself off-CDN. */
export function shopifyImageUrl(url: string, width: number): string {
  if (!isShopifyCdn(url)) return url;
  const u = new URL(url);
  u.searchParams.set('width', String(Math.round(width)));
  u.searchParams.set('format', 'webp');
  return u.toString();
}

/**
 * A srcset for `url` up to `maxWidth` (the widest the slot ever renders,
 * times two for dense screens), or undefined off-CDN so the browser keeps
 * the plain src.
 */
export function shopifySrcSet(url: string, maxWidth = 1600): string | undefined {
  if (!isShopifyCdn(url)) return undefined;
  const widths = WIDTHS.filter((w) => w <= maxWidth);
  if (!widths.length || widths[widths.length - 1] < maxWidth) widths.push(maxWidth as never);
  return widths.map((w) => `${shopifyImageUrl(url, w)} ${w}w`).join(', ');
}

/**
 * The srcset width a browser picks for a slot `slotCss` CSS pixels wide on a
 * `dpr` screen: the smallest candidate that covers it. Lets a background
 * warm-up fetch the exact URL the page will later ask for.
 */
export function srcsetPick(slotCss: number, dpr: number, maxWidth = 1600): number {
  const widths: number[] = WIDTHS.filter((w) => w <= maxWidth);
  if (!widths.length || widths[widths.length - 1] < maxWidth) widths.push(maxWidth);
  const need = slotCss * dpr;
  return widths.find((w) => w >= need) ?? widths[widths.length - 1];
}
