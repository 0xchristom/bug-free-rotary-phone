import { useEffect, useEffectEvent, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { focusables } from './focus.ts';

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Accessible name of the panel. */
  readonly label: string;
  /** The control that opens it; the caller toggles `open` from its click. */
  readonly trigger: ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  readonly align?: 'start' | 'end';
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A small panel under its trigger. Opening moves focus into it; Esc closes it and gives the
 * focus back to the trigger; a press anywhere outside closes it too.
 */
export function Popover({
  open,
  onClose,
  label,
  trigger,
  align = 'end',
  className,
  children,
}: PopoverProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const inside = panel.current;
    if (inside) (focusables(inside)[0] ?? inside).focus();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (anchor.current && target instanceof Node && !anchor.current.contains(target)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
    if (anchor.current) focusables(anchor.current)[0]?.focus();
  };

  return (
    // The wrapper only listens for Esc bubbling up from the controls inside it.
    <div className="k-pop-anchor" ref={anchor} onKeyDown={onKeyDown}>
      {trigger}
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className={cx('k-pop', align === 'start' && 'k-pop-start', className)}
        >
          {children}
        </div>
      )}
    </div>
  );
}
