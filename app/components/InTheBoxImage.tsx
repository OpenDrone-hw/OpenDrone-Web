import {useState, type PointerEvent, type ReactNode} from 'react';
import type {BoxItem, InTheBoxImage as Image} from '~/lib/product-content';
import {assetUrl} from '~/lib/asset-url';

/** WebP widths written beside every box render by `npm run gen:box-art`. */
const WIDTHS = [528, 800, 1024, 1280] as const;

// Beside the list on desktop the figure is at most ~40rem wide; stacked
// above it on phones it spans the column.
const SIZES = '(min-width: 64rem) min(60rem, 60vw), 100vw';

/** Alt text from the list itself, so it cannot drift from what ships. */
export function boxAlt(items: BoxItem[]): string {
  return items.map((it) => (it.qty ? `${it.qty} ${it.item}` : it.item)).join(', ');
}

type Props = {
  items: BoxItem[];
  image?: Image;
  /** The row's qty and item spans (the page adds the studio edit tags). */
  renderItem: (item: BoxItem, index: number) => ReactNode;
  /** Card stacked under the list, in the list's column (the provenance card). */
  aside?: ReactNode;
};

/**
 * The in-the-box list, and beside it the flat-lay render when there is one:
 * transparent PNG over the page background, WebP derivatives by width, lazy,
 * with its pixel size reserved so the list never jumps when it loads.
 *
 * With `image.boxes`, rows are numbered and each row's items carry the same
 * number in the image, in quiet corner-bracket boxes like the teardown
 * spotlight. Pointing at (or focusing) a row lights its boxes and dims the
 * rest; pointing at a box lights its row. A tap or Enter pins a row; tapping
 * it again unpins. The boxes are decoration for sighted readers: the list is
 * the accessible path, and the image's alt text reads the list.
 */
export function InTheBox({items, image, renderItem, aside}: Props) {
  const boxes = image?.boxes ?? [];
  const numbered = boxes.length > 0;
  // One number marker per row, on that row's largest box.
  const markerAt = new Map<number, number>();
  boxes.forEach((b, j) => {
    const k = markerAt.get(b.item);
    if (k === undefined || b.w * b.h > boxes[k].w * boxes[k].h) markerAt.set(b.item, j);
  });
  // Stack the boxes by area, largest at the back: a big box that encloses a
  // small one (the ESD bag around the board) must never sit on top of it, or
  // the small box could not be pointed at.
  const stack = new Map<number, number>();
  boxes
    .map((b, j) => [j, b.w * b.h] as const)
    .sort((a, b) => b[1] - a[1])
    .forEach(([j], rank) => stack.set(j, rank + 1));
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = hover ?? pinned;
  const toggle = (i: number) => setPinned((p) => (p === i ? null : i));
  // Mouse only: a touch "hover" would stick after the tap and fight the pin.
  const enter = (i: number) => (e: PointerEvent) => {
    if (e.pointerType === 'mouse') setHover(i);
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') setHover(null);
  };

  const list = (
    <ul className="in-the-box" data-numbered={numbered ? '' : undefined}>
      {items.map((it, i) => {
        const key = `${it.qty ?? ''}${it.item}`;
        if (!numbered) return <li key={key}>{renderItem(it, i)}</li>;
        const lit = active === i;
        return (
          <li
            key={key}
            className={`in-the-box-row${lit ? ' is-active' : ''}${active !== null && !lit ? ' is-dimmed' : ''}`}
          >
            <div
              className="in-the-box-row-hit"
              role="button"
              tabIndex={0}
              aria-pressed={pinned === i}
              onPointerEnter={enter(i)}
              onPointerLeave={leave}
              // Keyboard focus previews; a tap's focus must not, or the
              // second tap could never clear the highlight.
              onFocus={(e) => {
                if (e.currentTarget.matches(':focus-visible')) setHover(i);
              }}
              onBlur={() => setHover(null)}
              onClick={() => toggle(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(i);
                } else if (e.key === 'Escape') {
                  setPinned(null);
                }
              }}
            >
              <span className="in-the-box-num" aria-hidden="true">
                {i + 1}
              </span>
              {renderItem(it, i)}
            </div>
          </li>
        );
      })}
    </ul>
  );
  const column = (
    <div className="in-the-box-col">
      {list}
      {aside}
    </div>
  );
  if (!image) return <div className="in-the-box-plain">{column}</div>;

  const q = image.v ? `?v=${image.v}` : '';
  const at = (w: number) => assetUrl(`${image.src.replace(/\.png$/, `-w${w}.webp`)}${q}`);
  return (
    <div className="in-the-box-layout">
      <figure
        className={`in-the-box-figure${active !== null ? ' has-active' : ''}`}
        data-single={items.length === 1 ? '' : undefined}
      >
        <div className="in-the-box-stage">
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
          {numbered ? (
            <div className="in-the-box-marks" aria-hidden="true">
              {boxes.map((b, j) => (
                // Pointer shortcut only: the numbered list rows are the
                // keyboard and screen-reader path to the same highlight.
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                <span
                  // eslint-disable-next-line react/no-array-index-key
                  key={j}
                  className={`in-the-box-mark${active === b.item ? ' is-active' : ''}`}
                  style={{left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, zIndex: stack.get(j)}}
                  onPointerEnter={enter(b.item)}
                  onPointerLeave={leave}
                  onClick={() => toggle(b.item)}
                >
                  {markerAt.get(b.item) === j ? <span className="in-the-box-mark-num">{b.item + 1}</span> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </figure>
      {column}
    </div>
  );
}
