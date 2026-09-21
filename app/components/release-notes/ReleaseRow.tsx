import {shopifyImageUrl} from '~/lib/shopify-image';
import {Link} from 'react-router';
import {VersionChip, pickVersionTag} from './VersionChip';
import {FILTER_TAGS, type FilterTag} from './TagFilter';

export type ReleaseRowArticle = {
  id: string;
  handle: string;
  title: string;
  publishedAt: string;
  excerpt: string | null;
  tags: string[];
  image: {
    id?: string | null;
    altText: string | null;
    url: string;
    width?: number | null;
    height?: number | null;
  } | null;
};

function pickFilterTag(tags: readonly string[]): FilterTag | null {
  for (const t of tags) {
    const lower = t.toLowerCase();
    if ((FILTER_TAGS as readonly string[]).includes(lower)) {
      return lower as FilterTag;
    }
  }
  return null;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/**
 * One row in the release archive. Whole row is a single Link via the
 * `display: contents` trick on `.rn-row-link`, so the four-column grid
 * keeps its alignment without the link wrapping breaking it. Mobile
 * collapses to a single column via the existing media query in app.css.
 */
export function ReleaseRow({article}: {article: ReleaseRowArticle}) {
  const date = formatDate(article.publishedAt);
  const version = pickVersionTag(article.tags);
  const tag = pickFilterTag(article.tags);
  return (
    <li className="rn-row">
      <Link
        to={`/newsletter/${article.handle}`}
        className="rn-row-link"
        prefetch="viewport"
      >
        <span className="rn-date">{date}</span>
        <VersionChip version={version} />
        {!version ? <span className="rn-version is-empty">·</span> : null}
        <div className="rn-body">
          <h3 className="rn-headline">{article.title}</h3>
          {article.excerpt ? (
            <p className="rn-summary">{article.excerpt}</p>
          ) : null}
          {tag ? (
            <div className="rn-tagrow">
              <span className={`rn-tag is-${tag}`}>{tag}</span>
            </div>
          ) : null}
        </div>
        {article.image ? (
          <div className="rn-thumb">
            <img
              alt={article.image.altText || article.title}
              loading="lazy"
              src={shopifyImageUrl(article.image.url, 192)}
              style={{aspectRatio: '4/3'}}
              decoding="async"
            />
          </div>
        ) : (
          <div className="rn-thumb is-empty" aria-hidden />
        )}
      </Link>
    </li>
  );
}
