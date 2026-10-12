import { cx } from './cx.ts';
import type { Tone } from './tone.ts';

export interface ProgressBarProps {
  /** What is progressing, e.g. "Buy progress". */
  readonly label: string;
  readonly value: number;
  readonly max?: number;
  readonly tone?: Tone;
  /** What a screen reader says instead of the bare number, e.g. "3 of 8 wallets". */
  readonly valueText?: string;
  readonly className?: string;
}

/** Share of `max` done, clamped to 0–100%. `run` adds a moving sheen: work is in flight. */
export function ProgressBar({
  label,
  value,
  max = 100,
  tone = 'muted',
  valueText,
  className,
}: ProgressBarProps) {
  const top = Number.isFinite(max) && max > 0 ? max : 0;
  const done = Number.isFinite(value) ? Math.min(Math.max(value, 0), top) : 0;
  const percent = top === 0 ? 0 : (done / top) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={top}
      aria-valuenow={done}
      aria-valuetext={valueText}
      className={cx('k-bar', className)}
      data-tone={tone}
    >
      <div className="k-bar-fill" style={{ width: `${String(percent)}%` }} />
    </div>
  );
}
