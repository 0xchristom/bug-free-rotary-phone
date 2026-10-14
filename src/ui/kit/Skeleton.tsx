import { cx } from './cx.ts';

export interface SkeletonProps {
  /** A CSS length, e.g. `8ch`. Defaults to the full width of the parent. */
  readonly width?: string;
  readonly className?: string;
}

/** A placeholder line for a value that is still loading. Hidden from screen readers. */
export function Skeleton({ width, className }: SkeletonProps) {
  return (
    <span
      className={cx('k-skel', className)}
      aria-hidden="true"
      style={width === undefined ? undefined : { width }}
    />
  );
}
