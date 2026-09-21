import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {useId} from 'react';

/**
 * The only aside left is the mobile menu drawer. The cart drawer went
 * with the local cart (the cart icon links to the shop) and the search
 * drawer with predictive search (the listing filters client-side), so
 * their types are gone rather than kept as dead states.
 */
type AsideType = 'mobile' | 'closed';
type AsideContextValue = {
  type: AsideType;
  /** True while the aside is open as a non-modal hover preview. */
  preview: boolean;
  open: (mode: AsideType) => void;
  /** Open as a non-modal hover preview: no focus steal, no focus trap, no
   *  aria-modal, no body scroll-lock - until the visitor interacts inside
   *  the panel, at which point it upgrades ("pins") to a full modal. */
  openPreview: (mode: AsideType) => void;
  /** Upgrade the current preview to full modal behavior. */
  pin: () => void;
  close: () => void;
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * A side bar component with Overlay
 * @example
 * ```jsx
 * <Aside type="search" heading="SEARCH">
 *  <input type="search" />
 *  ...
 * </Aside>
 * ```
 */
export function Aside({
  children,
  heading,
  type,
}: {
  children?: React.ReactNode;
  type: AsideType;
  heading: React.ReactNode;
}) {
  const {type: activeType, preview, pin, close} = useAside();
  const expanded = type === activeType;
  // Hover-preview opens are deliberately non-modal (WCAG 3.2.1: an incidental
  // pointer graze must not yank focus, trap Tab, or lock the page). The full
  // dialog contract below only engages for real opens (click/keyboard/touch)
  // - or once the visitor interacts inside a preview, which pins it.
  const modal = expanded && !preview;
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Scroll-lock the document body while a modal Aside is open so background
  // content can't be scrolled behind the overlay. Paired with the focus
  // trap below so keyboard users can't tab outside the dialog.
  useEffect(() => {
    if (!modal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [modal]);

  useEffect(() => {
    if (!modal) return;

    const abortController = new AbortController();
    lastFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    // Move focus into the dialog on open. Prefer the first focusable
    // element inside it; fall back to the dialog itself. When the dialog
    // already contains focus (a preview pinned by an interaction inside),
    // leave the visitor's focus where they put it.
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialog).focus({preventScroll: true});
    }

    document.addEventListener(
      'keydown',
      function handler(event: KeyboardEvent) {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== 'Tab') return;
        // Focus trap - keep Tab cycling inside the dialog.
        const root = dialogRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
        if (!focusables.length) {
          event.preventDefault();
          root.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey) {
          if (active === first || !root.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last) {
          event.preventDefault();
          first.focus();
        }
      },
      {signal: abortController.signal},
    );

    return () => {
      abortController.abort();
      // Restore focus to whatever the user had focused before opening -
      // but never steal it back from an element the user focused outside
      // the dialog themselves (preview mode never took their focus).
      const prev = lastFocusedRef.current;
      const active = document.activeElement;
      const dialogEl = dialogRef.current;
      const focusIsOurs =
        !active ||
        active === document.body ||
        (dialogEl ? dialogEl.contains(active) : false);
      // A pinned preview can capture lastFocused INSIDE the dialog (the
      // focusin that pinned it). Restoring there would aim focus into the
      // now-hidden drawer subtree - skip and let focus fall to the body.
      const prevInsideDialog =
        !!prev && !!dialogEl && dialogEl.contains(prev);
      if (
        focusIsOurs &&
        prev &&
        !prevInsideDialog &&
        document.contains(prev)
      )
        prev.focus({preventScroll: true});
    };
  }, [close, modal]);

  // Preview mode: the first real interaction inside the panel means it's a
  // cart session now, not a peek - pin it, which engages the full modal
  // contract above (without re-stealing the focus the interaction set).
  // Escape still dismisses a preview even though focus never moved into it.
  useEffect(() => {
    if (!expanded || !preview) return;
    const dialog = dialogRef.current;
    const abortController = new AbortController();
    const onInteract = () => pin();
    dialog?.addEventListener('pointerdown', onInteract, {
      signal: abortController.signal,
    });
    dialog?.addEventListener('focusin', onInteract, {
      signal: abortController.signal,
    });
    document.addEventListener(
      'keydown',
      (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        // The preview is non-modal, so focus may legitimately sit in a page
        // input while the drawer peeks open. Let text-editing contexts and
        // anything that already claimed the event keep their Escape (clear
        // field, dismiss combobox, …) - only a "free" Escape dismisses the
        // preview.
        if (event.defaultPrevented) return;
        const target = event.target as HTMLElement | null;
        const isEditable =
          !!target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable);
        if (isEditable) return;
        event.preventDefault();
        close();
      },
      {signal: abortController.signal},
    );
    return () => abortController.abort();
  }, [expanded, preview, pin, close]);

  return (
    <div
      aria-modal={modal || undefined}
      aria-hidden={expanded ? undefined : true}
      className={`overlay ${expanded ? 'expanded' : ''}`}
      role="dialog"
      aria-labelledby={id}
      ref={dialogRef}
      tabIndex={-1}
    >
      <button className="close-outside" onClick={close} aria-label="Close" tabIndex={-1} />
      <aside>
        <header>
          <h3 id={id}>{heading}</h3>
          <button className="close reset" onClick={close} aria-label="Close">
            &times;
          </button>
        </header>
        <main>{children}</main>
      </aside>
    </div>
  );
}

const AsideContext = createContext<AsideContextValue | null>(null);

Aside.Provider = function AsideProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState<{type: AsideType; preview: boolean}>({
    type: 'closed',
    preview: false,
  });

  const open = useCallback(
    (type: AsideType) => setState({type, preview: false}),
    [],
  );
  const openPreview = useCallback(
    (type: AsideType) => setState({type, preview: true}),
    [],
  );
  const pin = useCallback(
    () => setState((s) => (s.preview ? {...s, preview: false} : s)),
    [],
  );
  const close = useCallback(
    () => setState({type: 'closed', preview: false}),
    [],
  );

  return (
    <AsideContext.Provider
      value={{
        type: state.type,
        preview: state.preview,
        open,
        openPreview,
        pin,
        close,
      }}
    >
      {children}
    </AsideContext.Provider>
  );
};

export function useAside() {
  const aside = useContext(AsideContext);
  if (!aside) {
    throw new Error('useAside must be used within an AsideProvider');
  }
  return aside;
}
