import {Fragment, type ReactNode} from 'react';
import {Link} from 'react-router';
import {isFlashHref} from '~/lib/flash-path';
import {parseRich} from '~/lib/rich-text';

/**
 * One guide string (`app/lib/guides.ts`) as React nodes: backtick runs become
 * <code>, the rest goes through the site's inline markup (links, strong, em).
 * Built as nodes, never as an HTML string, so there is no innerHTML here.
 *
 * Links to /guides/flash are plain anchors on purpose: that page's Permissions-Policy
 * (USB, serial) only applies to a freshly loaded document, and a client-side
 * navigation would keep this page's policy and block the device pickers.
 */
export function GuideText({value}: {value: string}): ReactNode {
  return value.split(/`([^`]+)`/).map((part, i) => {
    if (i % 2 === 1) return <code key={i}>{part}</code>;
    return (
      <Fragment key={i}>
        {parseRich(part).map((n, j) => {
          if (n.t === 'text') return <Fragment key={j}>{n.v}</Fragment>;
          if (n.t === 'em') return <em key={j}>{n.v}</em>;
          if (n.t === 'strong') return <strong key={j}>{n.v}</strong>;
          if (n.external) {
            return (
              <a key={j} href={n.href} target="_blank" rel="noopener noreferrer">
                {n.v}
              </a>
            );
          }
          if (isFlashHref(n.href)) {
            return (
              <a key={j} href={n.href}>
                {n.v}
              </a>
            );
          }
          return (
            <Link key={j} prefetch="intent" to={n.href}>
              {n.v}
            </Link>
          );
        })}
      </Fragment>
    );
  });
}

