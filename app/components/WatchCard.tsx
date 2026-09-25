import {useState} from 'react';
import {copyFill} from '~/lib/copy';

/**
 * The "Watch" bubble in the Open-for-learning chapter. A 16:9 card showing just
 * the real YouTube thumbnail with a centred gold play glyph over it - no caption
 * text (the thumbnail carries the title). Clicking opens the video on YouTube in
 * a new tab (no in-page player), so the PDP never loads any YouTube weight.
 */
export function WatchCard({
  videoId,
  title,
}: {
  videoId: string;
  title: string;
  // Accepted for call-site compatibility; not rendered (no caption).
  channel?: string;
}) {
  // maxres is the sharp 16:9 frame but only exists for HD uploads; fall back to
  // hqdefault (always present) if it 404s.
  const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const [poster, setPoster] = useState(maxres);

  // The PDP reuses one WatchCard instance across product navigation (same route,
  // same tree position), so `videoId` can change without a remount. useState's
  // initial value won't re-run, so reset the poster here or it stays the
  // previous product's thumbnail (correct href, wrong image).
  const [prevId, setPrevId] = useState(videoId);
  if (videoId !== prevId) {
    setPrevId(videoId);
    setPoster(maxres);
  }

  return (
    <a
      className="open-source-card watch-card"
      href={`https://www.youtube.com/watch?v=${videoId}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={copyFill('product-chrome.watch_aria', 'Watch on YouTube: {title}', {title})}
    >
      <img
        className="watch-card-thumb"
        src={poster}
        alt=""
        loading="lazy"
        onError={() =>
          setPoster(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)
        }
      />
      <span className="watch-card-overlay">
        <svg className="watch-card-yt" viewBox="0 0 28 20" aria-hidden="true">
          <path
            fill="currentColor"
            d="M27.4 3.12a3.5 3.5 0 0 0-2.46-2.48C22.76 0 14 0 14 0S5.24 0 3.06.64A3.5 3.5 0 0 0 .6 3.12 36.5 36.5 0 0 0 0 10a36.5 36.5 0 0 0 .6 6.88 3.5 3.5 0 0 0 2.46 2.48C5.24 20 14 20 14 20s8.76 0 10.94-.64a3.5 3.5 0 0 0 2.46-2.48A36.5 36.5 0 0 0 28 10a36.5 36.5 0 0 0-.6-6.88Z"
          />
          <path className="watch-card-yt-tri" d="M11.2 14.3 18.5 10 11.2 5.7Z" />
        </svg>
      </span>
    </a>
  );
}
