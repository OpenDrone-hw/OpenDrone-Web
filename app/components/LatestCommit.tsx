import type {LatestCommit} from '~/lib/github';
import {Txt} from './Txt';
import {copyFill, copyText} from '~/lib/copy';

function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return copyText('product-chrome.commit_just_now') ?? 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return copyFill('product-chrome.commit_ago_min', '{n} min ago', {n: m});
  const h = Math.floor(m / 60);
  if (h < 24) return copyFill('product-chrome.commit_ago_hour', '{n} h ago', {n: h});
  const d = Math.floor(h / 24);
  if (d < 30) return copyFill('product-chrome.commit_ago_day', '{n} d ago', {n: d});
  const mo = Math.floor(d / 30);
  if (mo < 12) return copyFill('product-chrome.commit_ago_month', '{n} mo ago', {n: mo});
  const y = Math.floor(d / 365);
  return copyFill('product-chrome.commit_ago_year', '{n} y ago', {n: y});
}

export function LatestCommitCard({commit}: {commit: LatestCommit}) {
  return (
    <a
      href={commit.url}
      target="_blank"
      rel="noopener noreferrer"
      className="latest-commit-card"
    >
      <p className="latest-commit-label">
        {copyText('product-chrome.commit_label')}{' '}
        <span>{commit.repoLabel}</span>
      </p>
      <p className="latest-commit-message">{commit.message}</p>
      <p className="latest-commit-meta">
        <span className="latest-commit-sha">{commit.shortSha}</span>
        <span aria-hidden="true"> · </span>
        <span>{commit.author}</span>
        <span aria-hidden="true"> · </span>
        <span>{relativeTime(commit.date)}</span>
      </p>
    </a>
  );
}

/**
 * Static stand-in for {@link LatestCommitCard} when the live GitHub fetch comes
 * back empty (the unauthenticated API is capped at 60 req/hour per IP, so the
 * edge gets rate-limited under load). Keeps the row's 4th card present on every
 * page - it just links to the repo's commit history instead of a single commit.
 */
export function CommitHistoryCard({repoUrl}: {repoUrl: string}) {
  return (
    <a
      href={`${repoUrl.replace(/\/$/, '')}/commits`}
      target="_blank"
      rel="noopener noreferrer"
      className="open-source-card"
    >
      <Txt
        id="product-chrome.commit_history_label"
        as="p"
        className="open-source-card-label"
      />
      <Txt
        id="product-chrome.commit_history_title"
        as="p"
        className="open-source-card-title"
      />
      <Txt
        id="product-chrome.commit_history_sub"
        as="p"
        className="open-source-card-sub"
      />
    </a>
  );
}

export function LatestCommitGrid({commits}: {commits: LatestCommit[]}) {
  if (commits.length === 0) return null;
  return (
    <div className="latest-commits">
      {commits.map((c) => (
        <LatestCommitCard key={c.sha + c.repoUrl} commit={c} />
      ))}
    </div>
  );
}

export function LatestCommitSkeleton({count = 1}: {count?: number}) {
  return (
    <div className="latest-commits" aria-hidden="true">
      {Array.from({length: count}, (_, i) => (
        <div key={i} className="latest-commit-card latest-commit-skeleton">
          <div className="latest-commit-skeleton-line latest-commit-skeleton-label" />
          <div className="latest-commit-skeleton-line latest-commit-skeleton-message" />
          <div className="latest-commit-skeleton-line latest-commit-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}
