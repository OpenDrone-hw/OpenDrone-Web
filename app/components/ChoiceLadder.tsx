import {useId} from 'react';
import {motion, useReducedMotion} from 'motion/react';

export type ChoiceLadderItem = {
  key: string;
  name: string;
  selected: boolean;
  disabled?: boolean;
  /** Which flag style the card takes: the greyed designed-but-unavailable one, or sold out. */
  tone?: 'comingsoon' | 'soldout';
  flag?: string;
  price?: string;
  pending?: boolean;
  /** Small mono line under the name (e.g. a chip or target name). */
  tag?: string;
};

/**
 * The product page's version selector markup (`variant-ladder`, `variant-tier`
 * cards, radiogroup with arrow keys), shared by VariantLadder (PDP) and /flash.
 * Presentation only: the callers decide what selecting does.
 */
export function ChoiceLadder({
  ariaLabel,
  items,
  tabbableKey,
  onSelect,
  disabledGroup = false,
  className,
}: {
  ariaLabel: string;
  items: ChoiceLadderItem[];
  tabbableKey: string | undefined;
  onSelect: (key: string) => void;
  /** Whole group locked (a device is busy): every card disabled. */
  disabledGroup?: boolean;
  /** Extra class on the group, for page-scoped spacing (the PDP passes none). */
  className?: string;
}) {
  const groupId = useId();
  const reducedMotion = useReducedMotion();
  return (
    <div
      className={className ? `variant-ladder ${className}` : 'variant-ladder'}
      role="radiogroup"
      tabIndex={-1}
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + direction + buttons.length) % buttons.length;
        buttons[next].focus();
        buttons[next].click();
      }}
    >
      <div className="variant-ladder-track">
        {items.map((item) => {
          const disabled = Boolean(item.disabled) || disabledGroup;
          return (
            <motion.button
              type="button"
              key={item.key}
              role="radio"
              aria-checked={item.selected}
              aria-disabled={disabled}
              disabled={disabled}
              tabIndex={item.key === tabbableKey ? 0 : -1}
              whileTap={disabled || reducedMotion ? undefined : {scale: 0.98}}
              aria-busy={item.pending || undefined}
              className={`variant-tier${item.selected ? ' is-selected' : ''}${
                item.tone === 'comingsoon' ? ' is-comingsoon' : item.tone === 'soldout' ? ' is-soldout' : ''
              }${item.pending ? ' is-pending' : ''}`}
              onClick={() => onSelect(item.key)}
            >
              {item.selected ? (
                <motion.span
                  className="variant-tier-glow"
                  layoutId={`${groupId}-selection`}
                  transition={reducedMotion ? {duration: 0} : {type: 'spring', stiffness: 500, damping: 38}}
                  aria-hidden="true"
                />
              ) : null}
              <span className="variant-tier-head">
                <span className="variant-tier-name">{item.name}</span>
                {item.flag ? <span className="variant-tier-flag">{item.flag}</span> : null}
              </span>
              {item.tag ? (
                // Above the selection glow, like variant-tier-head (otherwise the selected card hides its tag).
                <span className="relative z-[1] font-mono text-[12px] text-[var(--color-text-muted)]">{item.tag}</span>
              ) : null}
              {item.price ? <span className="variant-tier-price">{item.price}</span> : null}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
