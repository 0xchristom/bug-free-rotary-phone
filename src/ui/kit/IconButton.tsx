import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.ts';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'children' | 'aria-label' | 'aria-labelledby' | 'title'
> {
  /** Accessible name and tooltip. Required: an icon alone says nothing to a screen reader. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly variant?: 'neutral' | 'success' | 'danger' | 'ghost';
  /** `md` 36 px (top bar), `sm` 32 px (table row), `tiny` inline with text. */
  readonly size?: 'md' | 'sm' | 'tiny';
}

export function IconButton({
  label,
  icon,
  variant = 'neutral',
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx('k-iconbtn', `k-iconbtn-${variant}`, `k-iconbtn-${size}`, className)}
      {...rest}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );
}
