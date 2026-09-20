import {Component, type ReactNode} from 'react';

type Props = {
  children: ReactNode;
  /** Rendered in place of the 3D subtree once it has crashed. Defaults to
   *  nothing - the surrounding page (wordmark, CTAs, product copy) stays usable. */
  fallback?: ReactNode;
  /** Fired once on the first crash. The hero uses it to release its splash /
   *  scroll-lock so a WebGL failure never leaves the visitor stuck behind a
   *  loading overlay. */
  onError?: () => void;
};

/**
 * Catches render/lifecycle errors from a WebGL `<Canvas>` subtree - WebGL
 * context creation failures, lost contexts, bad geometry, driver quirks - and
 * swaps in a fallback instead of crashing the whole React tree. r3f has no
 * built-in boundary, so without this a 3D failure would take down the page.
 *
 * Async load failures (fetch/decode) are handled inside the loaders themselves
 * (they resolve their ready callbacks on error); this is the safety net for the
 * synchronous path.
 */
export class SceneErrorBoundary extends Component<Props, {crashed: boolean}> {
  state = {crashed: false};

  static getDerivedStateFromError() {
    return {crashed: true};
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('[3D] scene subtree crashed - falling back to no-3D:', error);
    this.props.onError?.();
  }

  render() {
    if (this.state.crashed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
