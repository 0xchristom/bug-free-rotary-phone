import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from './cx.ts';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
  readonly ref?: Ref<HTMLInputElement>;
}

/** A text field. The label is the caller's `<label htmlFor>`. */
export function Input({ invalid = false, className, type = 'text', ...rest }: InputProps) {
  return (
    <input
      type={type}
      className={cx('k-input', className)}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}

export interface NumberInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'inputMode'
> {
  /**
   * Shown inside the field, e.g. SOL, %, ms. Decoration: the `<label htmlFor>` next to the
   * field names the unit too.
   */
  readonly unit: string;
  readonly invalid?: boolean;
  readonly inputMode?: 'decimal' | 'numeric';
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * An amount with its unit. A text field on purpose: the app parses amounts itself (decimal
 * point or comma, no float rounding), which `type="number"` would get in the way of.
 */
export function NumberInput({
  unit,
  invalid = false,
  inputMode = 'decimal',
  className,
  ...rest
}: NumberInputProps) {
  return (
    <span className={cx('k-num', className)}>
      <input
        type="text"
        inputMode={inputMode}
        className="k-num-input"
        aria-invalid={invalid ? true : undefined}
        {...rest}
      />
      <span className="k-num-unit" aria-hidden="true">
        {unit}
      </span>
    </span>
  );
}
