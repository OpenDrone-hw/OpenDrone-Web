import {
  Link as RouterLink,
  NavLink as RouterNavLink,
  type LinkProps,
  type NavLinkProps,
} from 'react-router';

/**
 * Link / NavLink with `viewTransition` defaulted on, so every in-app
 * navigation through them animates (cross-fade/slide) instead of swapping
 * flat. Drop-in replacements for react-router's Link/NavLink - import these in
 * nav-heavy components (header, footer, hero) and every link there transitions
 * without per-link props. Callers can still override `viewTransition`.
 */
export function Link(props: LinkProps) {
  return <RouterLink viewTransition {...props} />;
}

export function NavLink(props: NavLinkProps) {
  return <RouterNavLink viewTransition {...props} />;
}
