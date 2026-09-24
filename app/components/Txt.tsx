import {Fragment} from 'react';
import type {ElementType, ReactNode} from 'react';
import {Link} from 'react-router';
import {copy, editAttrs} from '~/lib/copy';
import {isPlain, parseRich} from '~/lib/rich-text';

/**
 * Render one copy string, expanding its inline markup.
 *
 * Internal links go through React Router's `<Link>` so navigation stays
 * client-side and matches the rest of the site; external ones get the usual
 * `noreferrer` treatment.
 */
function Rich({value}: {value: string}) {
  if (isPlain(value)) return <>{value}</>;
  return (
    <>
      {parseRich(value).map((n, i) => {
        // Fragment, not <span>: the site's prose CSS targets things like
        // `p > a` and `.editorial-lead em`, and wrapping every plain run in a
        // span would quietly change what those selectors match.
        if (n.t === 'text') return <Fragment key={i}>{n.v}</Fragment>;
        if (n.t === 'em') return <em key={i}>{n.v}</em>;
        if (n.t === 'strong') return <strong key={i}>{n.v}</strong>;
        if (n.external) {
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
              {n.v}
            </a>
          );
        }
        return (
          <Link key={i} prefetch="intent" to={n.href}>
            {n.v}
          </Link>
        );
      })}
    </>
  );
}

/**
 * A string from the copy store, rendered with its studio annotation attached.
 *
 * One component rather than a `text()` helper plus a separate `attrs()` helper,
 * because two calls can disagree: annotate `hero_line1` while rendering
 * `hero_line2` and the studio silently edits the wrong string. Here the id is
 * given once and both the value and the tag come from it.
 *
 *   <Txt id="home.hero_line1" as="h1" className="hero-line" />
 *
 * A missing key renders `fallback`, or nothing. Deliberately not an error: a
 * typo should be visible in the studio, not a 500 on a live product page.
 */
export function Txt({
  id,
  as = 'span',
  className,
  fallback = null,
  ...rest
}: {
  id: string;
  as?: ElementType;
  className?: string;
  fallback?: ReactNode;
} & Record<string, unknown>) {
  const value = copy(id);

  // A bare `ElementType` makes TS resolve `children` to `never`, because it
  // intersects the props of every possible element. Narrowing to the two props
  // this component actually passes is enough to type the tag correctly without
  // reaching for `any`.
  const Tag = as as ElementType<{className?: string; children?: ReactNode}>;

  // Only strings and arrays of strings are renderable. `isPlain` coerces its
  // argument for the regex test, so an object sails through as
  // "[object Object]" and is then handed to React, which throws "Objects are
  // not valid as a React child" and 500s the route. `{"hero": {"en": …}}` is an
  // obvious first attempt at i18n, and the write endpoint applies no schema, so
  // the studio can persist exactly that. A bad value must degrade, never crash.
  if (
    value === undefined ||
    (typeof value !== 'string' && !Array.isArray(value))
  ) {
    return <>{fallback}</>;
  }

  // Emptied in the studio means GONE, not an empty element. The maintainer's rule
  // (2026-08-11): clearing a text box removes the thing it filled, and an
  // empty <p>/<h2> still carries its margins, which is exactly the stray
  // whitespace he flagged. Whitespace-only counts as emptied.
  if (typeof value === 'string' && value.trim() === '') {
    return <>{fallback}</>;
  }

  // An array is a run of paragraphs. Each gets its own annotation, indexed, so
  // the studio can edit one paragraph without rewriting the whole block.
  // Emptied entries are skipped the same way an emptied string is.
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((para, i) => {
          const text = typeof para === 'string' ? para : String(para ?? '');
          if (text.trim() === '') return null;
          return (
            <Tag
              key={i}
              className={className}
              {...editAttrs(`${id}.${i}`)}
              {...rest}
            >
              <Rich value={text} />
            </Tag>
          );
        })}
      </>
    );
  }

  return (
    <Tag className={className} {...editAttrs(id)} {...rest}>
      <Rich value={value} />
    </Tag>
  );
}
