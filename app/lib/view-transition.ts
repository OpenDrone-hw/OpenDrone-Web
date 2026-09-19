/**
 * Resilient wrapper around the View Transitions API.
 *
 * Two independent things start view transitions on this document:
 *   1. React Router (every <Link viewTransition>/<NavLink viewTransition> nav).
 *   2. The ThemeToggle's circular theme reveal (a manual startViewTransition).
 *
 * The browser only runs one transition at a time: starting a second one while
 * the first is live ABORTS the first. The aborted transition's `.ready` /
 * `.finished` / `.updateCallbackDone` promises then reject with
 * `InvalidStateError: Transition was aborted because of invalid state` (or an
 * `AbortError`). If those rejections aren't caught they flood the console, and
 * - worse - when the aborted one is a React Router *navigation* transition, its
 * state-commit render is interrupted, which can leave the next route (the PDP
 * board art) mounted but stuck pre-reveal until a refresh.
 *
 * This module:
 *   - tracks whether a transition is currently in flight,
 *   - refuses to start a *manual* transition while one is already running (it
 *     just applies the DOM update directly, so we never abort React Router's
 *     navigation transition out from under it), and
 *   - swallows AbortError/InvalidStateError on every promise it touches so a
 *     skipped/aborted transition can never surface as an unhandled rejection.
 *
 * React Router's own navigation transitions don't route through here, so we
 * also expose `markTransition()` for callers that hold a ViewTransition from
 * elsewhere and just want its rejections swallowed + the in-flight flag set.
 */

type ViewTransitionLike = {
  finished?: Promise<unknown>;
  ready?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
  skipTransition?: () => void;
};

type StartViewTransition = (cb: () => void | Promise<void>) => ViewTransitionLike;

let activeTransition: ViewTransitionLike | null = null;

/** Is a view transition (ours, or one we've been told about) currently live? */
export function isTransitionInFlight(): boolean {
  return activeTransition != null;
}

/** Swallow only the expected "transition got interrupted" rejections. */
function isInterruptionError(err: unknown): boolean {
  if (err == null) return true; // nothing useful to surface
  const name = (err as {name?: string}).name;
  return name === 'AbortError' || name === 'InvalidStateError';
}

function swallow(p: Promise<unknown> | undefined): void {
  // Attach a catch so an aborted/skipped transition never becomes an unhandled
  // rejection. Re-throw anything that isn't an interruption so real bugs still
  // surface.
  void p?.catch((err: unknown) => {
    if (!isInterruptionError(err)) throw err;
  });
}

/** Register an externally-created transition: set the flag, swallow its aborts. */
export function markTransition(vt: ViewTransitionLike | null | undefined): void {
  if (!vt) return;
  // Already tracking this exact transition (e.g. the document patch registered
  // it before safeStartViewTransition could) - don't double-attach handlers.
  if (activeTransition === vt) return;
  activeTransition = vt;
  swallow(vt.ready);
  swallow(vt.updateCallbackDone);
  void Promise.resolve(vt.finished)
    .catch((err: unknown) => {
      if (!isInterruptionError(err)) throw err;
    })
    .finally(() => {
      if (activeTransition === vt) activeTransition = null;
    });
}

/**
 * Patch `document.startViewTransition` ONCE so that *every* caller - including
 * React Router's internal navigation transitions, which don't go through
 * `safeStartViewTransition` - is recorded in our in-flight flag and has its
 * abort/interrupt rejections swallowed.
 *
 * This is what lets a manual theme transition know a navigation transition is
 * already running (so it skips instead of aborting it, which is what produced
 * the half-rendered board), and it stops React Router's own transition from
 * ever surfacing `InvalidStateError` as an unhandled rejection when it gets
 * skipped/interrupted by a rapid second navigation.
 *
 * Idempotent and SSR-safe. Call once from a client mount (root layout).
 */
const PATCH_FLAG = '__odViewTransitionPatched';

export function installViewTransitionGuard(): void {
  if (typeof document === 'undefined') return;
  if (!('startViewTransition' in document)) return;
  // Treat the document loosely here: we're wrapping a native method whose exact
  // DOM-lib signature we don't need to reproduce, only to call through.
  const doc = document as unknown as {
    startViewTransition?: (...args: unknown[]) => ViewTransitionLike;
    [PATCH_FLAG]?: boolean;
  };
  if (doc[PATCH_FLAG]) return;
  const original = doc.startViewTransition;
  if (typeof original !== 'function') return;
  doc[PATCH_FLAG] = true;

  doc.startViewTransition = function patchedStartViewTransition(
    this: typeof doc,
    ...args: unknown[]
  ): ViewTransitionLike {
    const vt = original.apply(this, args);
    markTransition(vt);
    return vt;
  };
}

/**
 * Run `update` inside a view transition when it's safe to do so, otherwise run
 * it directly. "Safe" = the API exists, we're not asked to reduce motion, and
 * no transition is already in flight (starting one would abort the running one).
 *
 * Always runs `update` exactly once. Never throws and never rejects.
 *
 * @returns the ViewTransition if one was started, else null (ran directly).
 */
export function safeStartViewTransition(
  update: () => void,
  opts?: {respectReducedMotion?: boolean},
): ViewTransitionLike | null {
  const reduce =
    opts?.respectReducedMotion !== false &&
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const supported =
    typeof document !== 'undefined' &&
    'startViewTransition' in document &&
    typeof (document as Document & {startViewTransition?: unknown})
      .startViewTransition === 'function';

  // Skip the transition (run the update directly) when unsupported, under
  // reduced motion, while the tab is hidden (the API can't snapshot a hidden
  // document and throws InvalidStateError), or while another transition is
  // already running (we'd abort it - e.g. an in-flight RR navigation).
  if (
    !supported ||
    reduce ||
    document.hidden ||
    isTransitionInFlight()
  ) {
    update();
    return null;
  }

  const start = (document as Document & {
    startViewTransition: StartViewTransition;
  }).startViewTransition.bind(document);

  try {
    const vt = start(update);
    markTransition(vt);
    return vt;
  } catch (err) {
    // startViewTransition itself threw (e.g. InvalidStateError because the
    // document entered an invalid state). The update callback never ran in that
    // case, so run it directly to keep the DOM/navigation consistent.
    if (!isInterruptionError(err)) throw err;
    update();
    return null;
  }
}
