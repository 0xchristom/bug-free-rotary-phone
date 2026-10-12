import type { CSSProperties } from 'react';
import { avatarPattern } from './avatar-pattern.ts';
import { cx } from './cx.ts';

export interface AvatarProps {
  /** A wallet address, a mint or a fleet name. */
  readonly seed: string;
  readonly size?: 'md' | 'sm';
  readonly className?: string;
}

/** A small picture that tells wallets apart at a glance. Decoration: the name is next to it. */
export function Avatar({ seed, size = 'md', className }: AvatarProps) {
  const { hue, cells } = avatarPattern(seed);
  const style: CSSProperties & Record<'--ava-hue', string> = { '--ava-hue': String(hue) };
  return (
    <svg
      className={cx('k-ava', size === 'sm' && 'k-ava-sm', className)}
      viewBox="-1 -1 7 7"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {cells.map(([x, y]) => (
        <rect key={`${String(x)}-${String(y)}`} x={x} y={y} width="1" height="1" />
      ))}
    </svg>
  );
}
