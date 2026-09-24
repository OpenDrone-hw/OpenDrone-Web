import {useEffect, useId, useState, type RefObject} from 'react';
import {
  AnimatePresence,
  motion,
  useInView,
  useScroll,
  useTransform,
  type MotionValue,
} from 'motion/react';
import {DURATION, EASE} from '~/lib/motion';
import {shopifyImageUrl} from '~/lib/shopify-image';
import {usePrefersReducedMotion} from '~/lib/use-media-query';

// Unmodified front exports from OpenDrone-Brand/board-art/. Import URLs so
// only the selected board loads, with a content hash supplied by Vite.
const boardArtwork = import.meta.glob<string>(
  '../assets/board-art/*-front.svg',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
);

type Artwork = {src: string; isBoard: boolean};

/** A local specs backdrop with a faint change in light as the table scrolls. */
export function ProductSilhouette({
  boardSrc,
  imageSrc,
  target,
}: {
  boardSrc: string | null;
  imageSrc: string | null;
  target: RefObject<HTMLDivElement | null>;
}) {
  const [ready, setReady] = useState<Artwork | null>(null);
  const nearSpecs = useInView(target, {margin: '250px', once: true});
  const reducedMotion = usePrefersReducedMotion();
  const {scrollYProgress} = useScroll({
    target,
    offset: ['start end', 'end start'],
  });
  const firstLight = useTransform(scrollYProgress, [0, 1], [0.75, 0.15]);
  const secondLight = useTransform(scrollYProgress, [0, 1], [0.15, 0.75]);

  const boardHandle = boardSrc?.match(/\/boards\/([^/]+)\//)?.[1];
  const artworkName = boardHandle === 'openesc' ? 'openesc-20x20' : boardHandle;
  const boardUrl = boardArtwork[`../assets/board-art/${artworkName}-front.svg`];
  const src = boardSrc
    ? boardUrl
    : imageSrc
      ? shopifyImageUrl(imageSrc, 640)
      : null;

  useEffect(() => {
    if (!nearSpecs || !src) {
      setReady(null);
      return;
    }
    let active = true;
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    // Keep the outgoing artwork until the next image can paint. Ignore a
    // late decode when the buyer has already selected another SKU.
    void image
      .decode()
      .then(() => {
        if (active) setReady({src, isBoard: Boolean(boardUrl)});
      })
      .catch(() => {
        if (active) setReady(null);
      });
    return () => {
      active = false;
    };
  }, [nearSpecs, src, boardUrl]);

  if (!nearSpecs) return null;
  const layer = ready ? (
    <SilhouetteLayer
      key={ready.src}
      artwork={ready}
      reducedMotion={reducedMotion}
      firstLight={firstLight}
      secondLight={secondLight}
    />
  ) : null;

  return (
    <div
      className="product-silhouette"
      aria-hidden="true"
      data-board={boardSrc ?? undefined}
    >
      <div className="product-silhouette-stage">
        <svg
          className="product-silhouette-art"
          viewBox="0 0 1000 1000"
          width="1000"
          height="1000"
          focusable="false"
        >
          {reducedMotion ? layer : <AnimatePresence>{layer}</AnimatePresence>}
        </svg>
      </div>
    </div>
  );
}

function SilhouetteLayer({
  artwork,
  reducedMotion,
  firstLight,
  secondLight,
}: {
  artwork: Artwork;
  reducedMotion: boolean;
  firstLight: MotionValue<number>;
  secondLight: MotionValue<number>;
}) {
  // Each overlapping image needs its own SVG masks during the crossfade.
  const id = useId();
  return (
    <motion.g
      className="product-silhouette-layer"
      initial={reducedMotion ? false : {opacity: 0}}
      animate={{opacity: 1}}
      exit={{opacity: 0}}
      transition={{
        duration: reducedMotion ? 0 : DURATION.slow,
        ease: [...EASE.settle],
      }}
    >
      <defs>
        <filter id={`${id}-cutout`} colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -1.5 -1.5 -1.5 0 3.5"
            result="ink"
          />
          <feComposite in="ink" in2="SourceAlpha" operator="in" />
        </filter>
        <linearGradient id={`${id}-light`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <linearGradient id={`${id}-light-reverse`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="black" />
          <stop offset="1" stopColor="white" />
        </linearGradient>
        <mask id={`${id}-light-mask`}>
          <rect width="1000" height="1000" fill={`url(#${id}-light)`} />
        </mask>
        <mask id={`${id}-light-reverse-mask`}>
          <rect width="1000" height="1000" fill={`url(#${id}-light-reverse)`} />
        </mask>
        <g id={`${id}-art`}>
          {artwork.isBoard ? (
            <image href={artwork.src} width="1000" height="1000" />
          ) : (
            <>
              <mask id={`${id}-shape`} style={{maskType: 'alpha'}}>
                <image
                  href={artwork.src}
                  width="1000"
                  height="1000"
                  filter={`url(#${id}-cutout)`}
                />
              </mask>
              <rect
                width="1000"
                height="1000"
                fill="currentColor"
                mask={`url(#${id}-shape)`}
              />
            </>
          )}
        </g>
      </defs>
      <use href={`#${id}-art`} opacity="0.25" />
      <motion.g
        className="product-silhouette-light"
        style={{opacity: reducedMotion ? 0.45 : firstLight}}
        mask={`url(#${id}-light-mask)`}
      >
        <use href={`#${id}-art`} />
      </motion.g>
      <motion.g
        className="product-silhouette-light"
        style={{opacity: reducedMotion ? 0.45 : secondLight}}
        mask={`url(#${id}-light-reverse-mask)`}
      >
        <use href={`#${id}-art`} />
      </motion.g>
    </motion.g>
  );
}
