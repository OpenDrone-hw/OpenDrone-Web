import {shopifyImageUrl} from '~/lib/shopify-image';
import {useSearchParams} from 'react-router';
import {useEffect, useMemo, useRef, useState} from 'react';
import {SmoothImage} from './SmoothImage';
import {Txt} from './Txt';
import {copyText} from '~/lib/copy';

type GalleryImage = {
  id?: string | null;
  url: string;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
};

const IMAGE_PARAM = 'image';

export function ProductGallery({
  images,
  activeImageId,
}: {
  images: GalleryImage[];
  activeImageId?: string | null;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  // Swipe tracker (declared before any early return so the hook order is stable).
  const touch = useRef<{x: number; y: number} | null>(null);
  const parsed = parseInt(searchParams.get(IMAGE_PARAM) ?? '', 10);
  const fallbackIndex = activeImageId
    ? Math.max(
        0,
        images.findIndex((img) => img.id === activeImageId),
      )
    : 0;
  const index =
    Number.isFinite(parsed) && parsed >= 0 && parsed < images.length
      ? parsed
      : fallbackIndex;

  useEffect(() => {
    if (!searchParams.has(IMAGE_PARAM)) return;
    if (parsed >= 0 && parsed < images.length) return;
    const next = new URLSearchParams(searchParams);
    next.delete(IMAGE_PARAM);
    setSearchParams(next, {replace: true, preventScrollReset: true});
  }, [parsed, images.length, searchParams, setSearchParams]);

  // Slide track. Every image the visitor has stepped to stays MOUNTED (its
  // own <img>, decoded, hidden with visibility) instead of one <img> whose src
  // is swapped per step: the swap discarded the previous bitmap and re-ran the
  // blur-up cover on every step, even back to a photo already seen (measured on
  // a phone, 2026-08-15). Neighbours of the active slide are mounted too so
  // a swipe lands on a decoded image; anything further out waits until it is
  // visited, so a long deck does not download every photo up front.
  const visited = useRef<Set<string>>(new Set());
  // Neighbours join only after the visitor first touches the gallery (a
  // pointer over it, a touch, a focus on its controls). Mounting them at
  // load fetched two more full-size photos (+650 KB per phone view) that
  // most visitors never step to, and competed with the LCP photo. Skipped
  // entirely under data-saver or a sub-4G link.
  const [warmNeighbours, setWarmNeighbours] = useState(false);
  const armNeighbours = () => {
    if (warmNeighbours) return;
    const conn = (
      navigator as {connection?: {saveData?: boolean; effectiveType?: string}}
    ).connection;
    if (conn?.saveData) return;
    if (/(^|\b)(slow-)?[23]g\b/.test(String(conn?.effectiveType ?? ''))) return;
    setWarmNeighbours(true);
  };
  const mounted = useMemo(() => {
    const keys = images.map((img) => img.id ?? img.url);
    visited.current.add(keys[index]);
    const set = new Set(visited.current);
    if (warmNeighbours && images.length > 1) {
      set.add(keys[(index + 1) % images.length]);
      set.add(keys[(index - 1 + images.length) % images.length]);
    }
    return set;
  }, [images, index, warmNeighbours]);

  if (images.length === 0) {
    return (
      <div className="product-gallery-empty">
        <Txt
          id="product-chrome.gallery_empty"
          as="span"
          className="product-card-media-ghost"
        />
      </div>
    );
  }

  const setIndex = (n: number) => {
    armNeighbours();
    const next = new URLSearchParams(searchParams);
    if (n === 0) next.delete(IMAGE_PARAM);
    else next.set(IMAGE_PARAM, String(n));
    setSearchParams(next, {replace: true, preventScrollReset: true});
  };

  const prev = () => setIndex(index === 0 ? images.length - 1 : index - 1);
  const next = () => setIndex(index === images.length - 1 ? 0 : index + 1);
  // Touch swipe: flick the main image ←/→ to step photos. Same threshold +
  // direction-ratio gate as the board explorer (BoardArt). Horizontal-only -
  // we never preventDefault, so a vertical drag still scrolls the page; only a
  // deliberate sideways flick (>44px and >1.3× the vertical travel) navigates.
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = {x: t.clientX, y: t.clientY};
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s || images.length < 2) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      if (dx < 0) next();
      else prev();
    }
  };

  return (
    <div className="product-gallery">
      <div
        className="product-gallery-main"
        role="group"
        aria-label={copyText('product-chrome.gallery_aria')}
        onTouchStart={(e) => {
          armNeighbours();
          onTouchStart(e);
        }}
        onTouchEnd={onTouchEnd}
        onPointerEnter={armNeighbours}
        onFocus={armNeighbours}
      >
        {images.map((img, i) => {
          const key = img.id ?? img.url;
          if (!mounted.has(key)) return null;
          const active = i === index;
          return (
            <div
              key={key}
              className={`product-gallery-slide${active ? ' is-active' : ''}`}
              aria-hidden={active ? undefined : 'true'}
            >
              <SmoothImage
                data={img}
                alt={
                  img.altText ||
                  copyText('product-chrome.gallery_image_alt') ||
                  ''
                }
                aspectRatio="1/1"
                sizes="(min-width: 960px) 60vw, 100vw"
                // The active slide is the PDP's LCP element: without an
                // explicit priority it competes with the route chunk + fonts
                // at default priority. Neighbours (mounted after idle) are
                // pre-decoded at low priority; a hidden slide is never lazy
                // (lazy + hidden would sit unloaded until the box intersects,
                // which it always does, at the wrong moment).
                loading="eager"
                fetchPriority={active ? 'high' : 'low'}
              />
            </div>
          );
        })}
        {images.length > 1 && (
          <div className="product-gallery-controls" aria-hidden="false">
            <button
              type="button"
              onClick={prev}
              aria-label={copyText('product-chrome.gallery_prev')}
              className="product-gallery-arrow"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <span className="product-gallery-counter" aria-live="polite">
              {index + 1}/{images.length}
            </span>
            <button
              type="button"
              onClick={next}
              aria-label={copyText('product-chrome.gallery_next')}
              className="product-gallery-arrow"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}
        {images.length > 1 && (
          <Txt
            id="product-chrome.swipe_hint"
            as="span"
            className="product-gallery-swipe-hint"
            aria-hidden="true"
          />
        )}
      </div>
      {/* Mobile swipe bar - the touch-first replacement for the arrow pill +
          thumbnail strip (both hidden on mobile via CSS). A tick per image (tap
          to jump) + counter + swipe hint, matching the board/schematic decks. */}
      {images.length > 1 && (
        <div className="product-gallery-deck">
          <div
            className="board-deck-dots"
            aria-label={copyText('product-chrome.gallery_deck_aria')}
          >
            {images.map((img, i) => (
              <button
                type="button"
                key={img.id ?? img.url}
                className={`board-deck-dot${i === index ? ' is-active' : ''}${
                  i < index ? ' is-done' : ''
                }`}
                aria-label={`${copyText('product-chrome.gallery_show_image_prefix') ?? ''} ${i + 1}`}
                aria-current={i === index ? 'true' : undefined}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
          <p className="board-deck-meta" aria-live="polite">
            <span className="board-deck-count">
              {index + 1}/{images.length}
            </span>
            <Txt
              id="product-chrome.swipe_hint"
              as="span"
              className="board-deck-hint"
            />
          </p>
        </div>
      )}
      {images.length > 1 && (
        <ul
          className="product-gallery-thumbs"
          role="tablist"
          aria-label={copyText('product-chrome.gallery_thumbs_aria')}
        >
          {images.map((img, i) => (
            <li key={img.id ?? img.url}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`${copyText('product-chrome.gallery_show_image_prefix') ?? ''} ${i + 1}`}
                aria-selected={i === index}
                role="tab"
                className={`product-gallery-thumb${
                  i === index ? ' is-active' : ''
                }`}
              >
                <img
                  src={shopifyImageUrl(img.url, 160)}
                  alt={
                    img.altText ||
                    `${copyText('product-chrome.gallery_thumb_alt_prefix') ?? ''} ${i + 1}`
                  }
                  style={{aspectRatio: '1/1'}}
                  width={80}
                  height={80}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
