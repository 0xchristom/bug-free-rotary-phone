import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * `neutral` everyday action, `primary` the one main action of a form, `success` buy,
 * `danger` sell / destructive, `warn` stop, `watch` arm, `ghost` quiet (cancel, back).
 */
export type ButtonVariant =
  'neutral' | 'primary' | 'success' | 'danger' | 'warn' | 'watch' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  readonly variant?: ButtonVariant;
  readonly size?: 'md' | 'sm';
  /** Work in progress: the button keeps its label, is disabled and reports aria-busy. */
  readonly loading?: boolean;
  readonly icon?: ReactNode;
  /** Key shown on the button; the screen wires the shortcut itself. Not part of the name. */
  readonly shortcut?: string;
  readonly type?: 'button' | 'submit';
}

export function Button({
  variant = 'neutral',
  size = 'md',
  loading = false,
  icon,
  shortcut,
  type = 'button',
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('k-btn', `k-btn-${variant}`, size === 'sm' && 'k-btn-sm', className)}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {loading ? <span className="k-spin" aria-hidden="true" /> : icon}
      {children}
      {shortcut !== undefined && <kbd aria-hidden="true">{shortcut}</kbd>}
    </button>
  );
}
