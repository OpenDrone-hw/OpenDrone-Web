import type {BoxItem, InTheBoxImage as Image} from '~/lib/product-content';
import {assetUrl} from '~/lib/asset-url';

/** WebP widths written beside every box render by `npm run gen:box-art`. */
const WIDTHS = [528, 800, 1024, 1280] as const;

// Beside the list on desktop the figure is at most ~40rem wide; stacked
// above it on phones it spans the column.
const SIZES = '(min-width: 64rem) min(40rem, 45vw), 100vw';

/** Alt text from the list itself, so it cannot drift from what ships. */
export function boxAlt(items: BoxItem[]): string {
  return items.map((it) => (it.qty ? `${it.qty} ${it.item}` : it.item)).join(', ');
}

/**
 * The in-the-box flat-lay render: transparent PNG over the page background,
 * WebP derivatives by width, lazy, with its pixel size reserved so the list
 * never jumps when it loads.
 */
export function InTheBoxImage({image, items}: {image: Image; items: BoxItem[]}) {
  const q = image.v ? `?v=${image.v}` : '';
  const at = (w: number) => assetUrl(`${image.src.replace(/\.png$/, `-w${w}.webp`)}${q}`);
  return (
    <figure className="in-the-box-figure" data-single={items.length === 1 ? '' : undefined}>
      <picture>
        <source type="image/webp" srcSet={WIDTHS.map((w) => `${at(w)} ${w}w`).join(', ')} sizes={SIZES} />
        <img
          className="in-the-box-image"
          src={assetUrl(`${image.src}${q}`)}
          alt={image.alt ?? boxAlt(items)}
          width={image.width}
          height={image.height}
          loading="lazy"
          decoding="async"
        />
      </picture>
    </figure>
  );
}
