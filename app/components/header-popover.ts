import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {FocusEvent} from 'react';
import {useLocation} from 'react-router';

/**
 * Open/close state for a header dropdown (currency menu, "More" links).
 * Closes on Escape (focus returns to the trigger), on a pointer press outside,
 * when focus leaves the widget, and on navigation. Attach `rootRef` and
 * `onBlur` to the wrapper element and `triggerRef` to the trigger button.
 */
export function useHeaderPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const {pathname, search} = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [pathname, search]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // The panel hangs from the trigger's right edge; on a narrow phone that
  // can push it past the left edge of the screen. Shift it back inside,
  // with a 12 px margin, before it paints.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = rootRef.current?.querySelector<HTMLElement>('.header-popover-panel');
    if (!panel) return;
    panel.style.translate = '';
    const margin = 12;
    const rect = panel.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const shift =
      rect.left < margin ? margin - rect.left : rect.right > vw - margin ? vw - margin - rect.right : 0;
    if (shift) panel.style.translate = `${Math.round(shift)}px 0`;
  }, [open]);

  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !e.currentTarget.contains(next)) setOpen(false);
  }, []);

  return {open, setOpen, close, rootRef, triggerRef, onBlur};
}
