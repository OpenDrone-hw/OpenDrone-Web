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

/** The legal text's classes: subheads that read as subheads (17px, 600,
 *  air above) and a 68ch measure for the prose, so a long page does not
 *  read as one block. */
const LEGAL_BODY =
  'rich-content legal-body [&_h3]:mt-8! [&_h3]:text-[17px]! [&_h3]:font-semibold! [&_p]:max-w-[68ch] [&_li]:max-w-[68ch]';

export function LegalPage({
  title,
  eyebrow = 'Legal',
  html,
  locale = 'en',
  lastUpdated,
  summary,
  back,
  className,
  children,
}: {
  title: string;
  eyebrow?: string;
  html?: string;
  locale?: Locale;
  lastUpdated?: string;
  /** A short buyer summary shown above the legal text (shipping). */
  summary?: React.ReactNode;
  /** Where the back link goes instead of the legal overview: a help page
   *  a buyer reaches from the cart (shipping) points back to Support. */
  back?: {to: string; label: string};
  /** Extra class on the page, for page-specific table styling. */
  className?: string;
  children?: React.ReactNode;
}) {
  const overviewHref = `/${locale}/legal`;
  const ui = LEGAL_UI_STRINGS[locale];
  return (
    <article className={`legal-page page-shell${className ? ` ${className}` : ''}`}>
      <div className="reading-column">
        <div className="policy-back-link">
          <Link prefetch="viewport" to={back?.to ?? overviewHref}>
            {back?.label ?? ui.backToOverview}
          </Link>
        </div>
        <header className="page-header">
          <p className="page-eyebrow">{eyebrow}</p>
          <h1 className="page-title">{title}</h1>
        </header>

        {summary}

        {html ? (
          <div
            className={LEGAL_BODY}
            dangerouslySetInnerHTML={{__html: singleH1(html, title)}}
          />
        ) : null}

        {children ? <div className={LEGAL_BODY}>{children}</div> : null}

        {lastUpdated ? (
          <p className="legal-last-updated">
            {ui.lastUpdated}: {lastUpdated}
          </p>
        ) : null}
      </div>
    </article>
  );
}
