/**
 * Content-Security-Policy and the render nonce.
 *
 * This replaces Hydrogen's `createContentSecurityPolicy` / `useNonce` /
 * `NonceProvider`. Not because they misbehaved, but because importing
 * `@shopify/hydrogen` at runtime also merges its Storefront client, cart
 * handler and customer-account client into React Router's context type,
 * and none of those exist any more. Nothing in the app calls Shopify at
 * runtime; this keeps the types honest about that.
 *
 * The directives are the ones the site was already serving: same hosts,
 * same nonce mechanics, `'strict-dynamic'` deliberately absent (the site
 * loads no third-party loader scripts that would need it).
 */

import {createContext, createElement, useContext, type ReactNode} from 'react';

export type CspDirectives = {
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  connectSrc?: string[];
  frameSrc?: string[];
  mediaSrc?: string[];
  fontSrc?: string[];
};

const NonceContext = createContext<string | undefined>(undefined);

/** The per-request nonce, for every inline <script> and <style>. */
export function useNonce(): string | undefined {
  return useContext(NonceContext);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function directive(name: string, values: string[]): string {
  return `${name} ${values.join(' ')}`;
}

/**
 * Build the policy and the provider for one request. Each directive the
 * caller passes REPLACES the default for that directive (it does not
 * merge), so a caller adding one host must list the defaults it still
 * needs — same contract the previous implementation had.
 */
export function createContentSecurityPolicy(directives: CspDirectives = {}): {
  nonce: string;
  header: string;
  NonceProvider: (props: {children: ReactNode}) => ReactNode;
} {
  const nonce = randomNonce();
  const nonceSrc = `'nonce-${nonce}'`;

  const parts = [
    directive('base-uri', ["'self'"]),
    directive('default-src', ["'self'", nonceSrc]),
    directive('frame-ancestors', ["'none'"]),
    directive('script-src', [
      ...(directives.scriptSrc ?? ["'self'", 'https://cdn.shopify.com']),
      nonceSrc,
    ]),
    directive(
      'style-src',
      directives.styleSrc ?? ["'self'", "'unsafe-inline'", 'https://cdn.shopify.com'],
    ),
    directive(
      'img-src',
      directives.imgSrc ?? ["'self'", 'data:', 'https://cdn.shopify.com'],
    ),
    directive(
      'connect-src',
      directives.connectSrc ?? ["'self'", 'https://cdn.shopify.com'],
    ),
    directive('font-src', directives.fontSrc ?? ["'self'", 'data:']),
    directive('frame-src', directives.frameSrc ?? ["'self'"]),
    directive('media-src', directives.mediaSrc ?? ["'self'"]),
  ];

  const RequestNonceProvider = ({children}: {children: ReactNode}) =>
    createElement(NonceProvider, {value: nonce}, children);

  return {nonce, header: parts.join('; '), NonceProvider: RequestNonceProvider};
}

/** Client-side counterpart: re-supplies the server nonce on hydration. */
export function NonceProvider({
  value,
  children,
}: {
  value?: string;
  children?: ReactNode;
}) {
  return createElement(NonceContext.Provider, {value}, children);
}
