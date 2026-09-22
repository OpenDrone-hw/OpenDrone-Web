import {Link} from 'react-router';
import {LEGAL_UI_STRINGS, type Locale} from '~/lib/i18n';

/**
 * Shared layout for legal/compliance routes. Receives already-rendered
 * HTML for the active locale from the route loader. Page chrome (title,
 * eyebrow, back-link, "Last updated") localises via `locale`; the
 * legal body HTML is rendered as-is from the per-locale Markdown file.
 */
/**
 * The page has one h1, the title above. A body that still carries its own
 * `# Heading` (a Markdown file with front matter keeps it) loses that
 * heading when it only repeats the title, and has it rendered as an h2
 * otherwise, so no text is dropped.
 */
function singleH1(html: string, title: string): string {
  const plain = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  return html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi, (_m, attrs: string, inner: string) =>
    plain(inner) === plain(title) ? '' : `<h2${attrs}>${inner}</h2>`,
  );
}

export function LegalPage({
  title,
  eyebrow = 'Legal',
  html,
  locale = 'en',
  lastUpdated,
  children,
}: {
  title: string;
  eyebrow?: string;
  html?: string;
  locale?: Locale;
  lastUpdated?: string;
  children?: React.ReactNode;
}) {
  const overviewHref = `/${locale}/legal`;
  const ui = LEGAL_UI_STRINGS[locale];
  return (
    <article className="legal-page page-shell">
      <div className="reading-column">
        <div className="policy-back-link">
          <Link prefetch="viewport" to={overviewHref}>{ui.backToOverview}</Link>
        </div>
        <header className="page-header">
          <p className="page-eyebrow">{eyebrow}</p>
          <h1 className="page-title">{title}</h1>
        </header>

        {html ? (
          <div
            className="rich-content legal-body"
            dangerouslySetInnerHTML={{__html: singleH1(html, title)}}
          />
        ) : null}

        {children ? <div className="rich-content legal-body">{children}</div> : null}

        {lastUpdated ? (
          <p className="legal-last-updated">
            {ui.lastUpdated}: {lastUpdated}
          </p>
        ) : null}
      </div>
    </article>
  );
}
