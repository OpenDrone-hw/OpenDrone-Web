import {Link} from 'react-router';
import {copyText} from '~/lib/copy';

// `label` is a ReactNode so a crumb can be a <Txt> from the copy store and
// stay editable in the studio; catalog-sourced crumbs stay plain strings.
export type Crumb = {label: React.ReactNode; to?: string};

export function Breadcrumb({items}: {items: Crumb[]}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={copyText('chrome.breadcrumb_aria') ?? 'Breadcrumb'}
      className="breadcrumb"
    >
      <ol>
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            // A crumb's `to` is its identity; the trailing current-page crumb
            // is the only one without one.
            <li key={item.to ?? 'current'}>
              {item.to && !isLast ? (
                <Link to={item.to} prefetch="viewport">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>
                  {item.label}
                </span>
              )}
              {!isLast && (
                <span className="breadcrumb-sep" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
