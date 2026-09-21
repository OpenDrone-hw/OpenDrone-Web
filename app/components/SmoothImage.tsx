import {useEffect, useRef, useState} from 'react';
import type {ProductImage} from '~/lib/product-shapes';
import {shopifySrcSet} from '~/lib/shopify-image';

export type SmoothImageProps = {
  /** The image to render; null renders nothing. */
  data?: ProductImage | {url: string; altText?: string | null} | null;
  src?: string;
  alt?: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  sizes?: string;
  /** Widest rendered size in device pixels; caps the Shopify srcset. */
  maxWidth?: number;
  aspectRatio?: string;
  fetchPriority?: 'high' | 'low' | 'auto';
};

/**
 * A plain <img> with a blur-up cover while the file streams in. SSR-safe:
 * the image renders visible by default; only after hydration, if the file
 * hasn't arrived yet, a cover fades over it - a heavily blurred ~1 KB CDN
 * thumb of the same image (flat `--color-bg-elevated` when no thumb URL can
 * be derived) - and crossfades away on load. The cover is absolutely
 * positioned inside the existing wrapper, so aspect-ratio handling and
 * layout are untouched (no shift). Cached images never see it; reduced
 * motion swaps without the fade. No hydration mismatch, no invisible
 * images without JS.
 */
export function SmoothImage(props: SmoothImageProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'loaded'>('idle');

  // Re-arm whenever the source changes (e.g. PDP gallery paging), so each
  // new file gets its own blur-up instead of a blank swap.
  const srcUrl =
    (props.data && typeof props.data.url === 'string' ? props.data.url : null) ??
    (typeof props.src === 'string' ? props.src : null);
  // No cheap thumbnail URL is derived for the blur-up: the cover is the
  // flat token background.
  const tiny: string | null = null;

  // Synchronous re-arm on source change (sanctioned derived-state pattern:
  // setting state during render restarts the render before commit). Without
  // it the first committed frame after a source swap still has phase
  // 'loaded', so the cover would mount lifted and fade IN over the
  // stale/blank main image instead of appearing instantly.
  const [armedFor, setArmedFor] = useState(srcUrl);
  if (armedFor !== srcUrl) {
    setArmedFor(srcUrl);
    setPhase('loading');
  }

  useEffect(() => {
    // `:scope > img` - the main image is the wrapper's direct child; never
    // match the cover's own thumb img.
    const img = wrapRef.current?.querySelector<HTMLImageElement>(
      ':scope > img',
    );
    if (!img) return;
    if (img.complete) {
      // Already cached - drop any cover from a previous source, never
      // flash one for this one.
      setPhase('idle');
      return;
    }
    setPhase('loading');
    const done = () => setPhase('loaded');
    img.addEventListener('load', done);
    img.addEventListener('error', done);
    return () => {
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
    };
  }, [srcUrl]);

  return (
    <div ref={wrapRef} className="smooth-media">
      {srcUrl ? (
        <img
          src={srcUrl}
          alt={props.alt ?? props.data?.altText ?? ''}
          className={props.className}
          loading={props.loading ?? 'lazy'}
          decoding="async"
          srcSet={props.sizes ? shopifySrcSet(srcUrl, props.maxWidth) : undefined}
          sizes={props.sizes}
          fetchPriority={props.fetchPriority}
          style={props.aspectRatio ? {aspectRatio: props.aspectRatio} : undefined}
        />
      ) : null}
      {phase !== 'idle' ? (
        // Keyed by source so a re-arm swaps in a FRESH node at full opacity
        // instead of transitioning the old (lifted, mid-fade) one back up.
        // Once the lift fade finishes the cover leaves the DOM entirely;
        // under reduced motion the transition is disabled so no
        // transitionend fires and the invisible cover simply stays - the
        // pre-existing (harmless) behavior.
        <div
          key={srcUrl ?? 'cover'}
          className={`smooth-media-cover${phase === 'loaded' ? ' is-lifted' : ''}${
            tiny ? '' : ' no-thumb'
          }`}
          aria-hidden="true"
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && phase === 'loaded') {
              setPhase('idle');
            }
          }}
        >
          {tiny ? (
            <img
              src={tiny}
              alt=""
              loading={props.loading === 'eager' ? 'eager' : 'lazy'}
              decoding="async"
              draggable={false}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
