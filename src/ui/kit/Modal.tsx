import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.ts';
import { focusables } from './focus.ts';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  /** `alertdialog`: a decision that interrupts (confirm spending, arming). */
  readonly role?: 'dialog' | 'alertdialog';
  /** `danger`: the decision spends money or shows secrets. */
  readonly tone?: 'neutral' | 'danger';
  /** `false` while work that must not be interrupted runs: Esc and the backdrop do nothing. */
  readonly dismissible?: boolean;
  /** The buttons, right-aligned under the body. */
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * A dialog over the page. Focus moves in when it opens, Tab stays inside, Esc closes it and
 * the focus goes back to the control that opened it.
 */
export function Modal({
  open,
  onClose,
  title,
  role = 'dialog',
  tone = 'neutral',
  dismissible = true,
  footer,
  className,
  children,
}: ModalProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const inside = dialog.current;
    if (inside) (focusables(inside)[0] ?? inside).focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const inside = event.currentTarget;
    const stops = focusables(inside);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      inside.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="k-overlay"
      onPointerDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={role === 'alertdialog' ? bodyId : undefined}
        tabIndex={-1}
        className={cx('k-modal', tone === 'danger' && 'k-modal-danger', className)}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="k-modal-title">
          {title}
        </h2>
        <div id={bodyId} className="k-modal-body">
          {children}
        </div>
        {footer !== undefined && <div className="k-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
