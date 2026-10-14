import { cx } from './cx.ts';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
}

export interface SegmentedProps<T extends string> {
  /** Name of the group, e.g. "Network". */
  readonly label: string;
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  /** Says why the whole group is off, when it is. */
  readonly title?: string | undefined;
  readonly className?: string;
}

/** One of a few choices, all visible. Picking the current one again does nothing. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  title,
  className,
}: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} title={title} className={cx('k-seg', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled || option.disabled === true}
          title={option.title}
          onClick={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
