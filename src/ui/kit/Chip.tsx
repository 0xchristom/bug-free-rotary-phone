import type { ReactNode } from 'react';
import { cx } from './cx.ts';
import type { Tone } from './tone.ts';

export interface ChipProps {
  readonly tone?: Tone;
  /** `md` status pill, `sm` the small value tag inside a table cell. */
  readonly size?: 'md' | 'sm';
  readonly icon?: ReactNode;
  /** A blinking dot: the thing is in flight right now. */
  readonly dot?: boolean;
  readonly title?: string;
  /** Replaces the text for screen readers when the text alone is too short to be clear. */
  readonly 'aria-label'?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/** A state in words on its tone. The colour never stands alone: the text says it too. */
export function Chip({
  tone = 'muted',
  size = 'md',
  icon,
  dot = false,
  title,
  'aria-label': ariaLabel,
  className,
  children,
}: ChipProps) {
  return (
    <span
      className={cx('k-chip', size === 'sm' && 'k-chip-sm', className)}
      data-tone={tone}
      title={title}
      aria-label={ariaLabel}
    >
      {dot && <span className="k-dot" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}
