import {Link} from 'react-router';

type Sibling = {handle: string; title: string; publishedAt: string};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/**
 * Prev / Next two-card row at the foot of an individual release post.
 * `previous` is the release published before this one (older); `next`
 * is the more recent one. Either can be null at the ends - we render an
 * empty grid cell so the two-up layout doesn't collapse.
 */
export function PrevNextNav({
  previous,
  next,
}: {
  previous: Sibling | null;
  next: Sibling | null;
}) {
  return (
    <nav className="rn-post-footer" aria-label="Post navigation">
      {previous ? (
        <Link
          to={`/newsletter/${previous.handle}`}
          className="rn-pn rn-prev"
          prefetch="viewport"
        >
          <span className="rn-k">← Previous</span>
          <span className="rn-pn-title">{previous.title}</span>
          <span className="rn-pn-date">{formatDate(previous.publishedAt)}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          to={`/newsletter/${next.handle}`}
          className="rn-pn rn-next"
          prefetch="viewport"
        >
          <span className="rn-k">Next →</span>
          <span className="rn-pn-title">{next.title}</span>
          <span className="rn-pn-date">{formatDate(next.publishedAt)}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
