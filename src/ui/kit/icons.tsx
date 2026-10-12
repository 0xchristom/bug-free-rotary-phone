import { useId, type ReactNode } from 'react';
import { cx } from './cx.ts';

/**
 * The icon set: 16 px grid, 1.6 px stroke, colour from the text around it. Icons are
 * decoration (aria-hidden); the control that holds one carries the accessible name.
 */
export interface IconProps {
  readonly className?: string;
}

function Svg({ className, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg className={cx('k-i', className)} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect className="k-i-solid" x="4" y="4" width="8" height="8" rx="1.5" />
    </Svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.5 4v8M10.5 4v8" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path className="k-i-solid" d="M5 3.5v9l7.5-4.5z" />
    </Svg>
  );
}

/** Buy: value comes in. */
export function InIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4 4.5 11.5M4.5 6v5.5H10" />
    </Svg>
  );
}

/** Sell: value goes out. */
export function OutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12l7.5-7.5M6 4.5h5.5V10" />
    </Svg>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3 13 .6-2.8 7.3-7.3a1.2 1.2 0 0 1 1.7 0l.5.5a1.2 1.2 0 0 1 0 1.7l-7.3 7.3L3 13Z" />
    </Svg>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 3H13v3.5M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Svg>
  );
}

/** Arm: the watcher takes aim at a creator. */
export function AimIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4.5" />
      <circle className="k-i-solid" cx="8" cy="8" r="1" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </Svg>
  );
}

export function SortIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" />
    </Svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 5h5.5M12.5 5H13M3 11h.5M7.5 11H13" />
      <circle cx="10.5" cy="5" r="1.8" />
      <circle cx="5.5" cy="11" r="1.8" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3L7.5 5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </Svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8a5 5 0 0 1-9 3M3 8a5 5 0 0 1 9-3" />
      <path d="M12.5 2.5V5H10M3.5 13.5V11H6" />
    </Svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.2 3.8A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.500a11 11 0 0 1-1.9 2.400M10.8 11.800A6 6 0 0 1 8 12.500C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.7-3.1" />
      <path d="m2.5 2.5 11 11" />
    </Svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.500M3 13.500h10" />
    </Svg>
  );
}

export function QrIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.8" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="0.8" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.8" />
      <path d="M9.5 9.5h1.500v1.500M13.5 9.500v4h-4" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5 14 13H2L8 2.500Z" />
      <path d="M8 6.500v3M8 11.300v.2" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.500V11M8 5v.2" />
    </Svg>
  );
}

export function BellOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 11.500V7a3.5 3.5 0 0 1 5.8-2.600M11.5 7.500v4M3 11.500h8.500M6.5 13.500h3" />
      <path d="m2.5 2.5 11 11" />
    </Svg>
  );
}

/** Solana mark in its own gradient (tokens `--sol-a`, `--sol-b`). */
export function SolIcon({ className }: IconProps) {
  const gradient = useId();
  return (
    <svg
      className={cx('k-i k-i-sol', className)}
      viewBox="0 0 14 12"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="0" y1="12" x2="14" y2="0" gradientUnits="userSpaceOnUse">
          <stop className="k-sol-a" />
          <stop className="k-sol-b" offset="1" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradient})`}
        d="M2.6.5h11L11.4 2.9H.4zM.4 4.8h11l2.2 2.4h-11zM2.6 9.1h11l-2.2 2.4H.4z"
      />
    </svg>
  );
}

/** Bunndly mark. */
export function BrandMark({ className }: IconProps) {
  return (
    <svg
      className={cx('k-brand-mark', className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="k-brand-tile" width="24" height="24" rx="7" />
      <path className="k-brand-ink" d="M8.5 5.5v13" />
      <circle className="k-brand-ink" cx="12.7" cy="14.2" r="4.2" />
    </svg>
  );
}
