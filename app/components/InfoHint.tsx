import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {Info} from 'lucide-react';

const useBeforePaint =
  typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Supporting detail, available by mouse, keyboard and touch. */
export function InfoHint({
  label,
  iconOnly = false,
  children,
}: {
  label: string;
  iconOnly?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [placement, setPlacement] = useState({above: false, maxHeight: 400});
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  const show = () => {
    const box = root.current?.getBoundingClientRect();
    if (box) {
      const width = Math.min(300, window.innerWidth - 40);
      setOffset(
        Math.max(
          20,
          Math.min(box.right - width, window.innerWidth - width - 20),
        ) - box.left,
      );
    }
    setOpen(true);
  };

  useBeforePaint(() => {
    if (!open || !root.current || !panel.current) return;
    const box = root.current.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 16;
    const above = box.top - 16;
    const useAbove = panel.current.scrollHeight > below && above > below;
    setPlacement({
      above: useAbove,
      maxHeight: Math.max(100, useAbove ? above : below),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className="info-hint"
      data-above={placement.above || undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') show();
      }}
      onPointerLeave={() => {
        if (!pinned.current && !root.current?.contains(document.activeElement))
          close();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <button
        type="button"
        id={`${id}-label`}
        className={`info-hint-trigger${iconOnly ? ' info-hint-trigger--icon' : ''}`}
        aria-label={iconOnly ? label : undefined}
        aria-expanded={open}
        aria-controls={id}
        onFocus={show}
        onClick={() => {
          if (pinned.current) close();
          else {
            pinned.current = true;
            show();
          }
        }}
      >
        {iconOnly ? null : label}
        <Info size={14} aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={id}
        className="info-hint-panel"
        style={{left: offset, maxHeight: placement.maxHeight}}
        role="region"
        aria-labelledby={`${id}-label`}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
