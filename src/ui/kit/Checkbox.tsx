import { useEffect, useRef, type InputHTMLAttributes } from 'react';
import { cx } from './cx.ts';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'checked' | 'onChange'
> {
  /** `mixed`: some of the rows it stands for are selected. A click on it selects all. */
  readonly checked: boolean | 'mixed';
  readonly onChange: (checked: boolean) => void;
}

/** A three-state checkbox. Name it with `aria-label` or a `<label>` around it. */
export function Checkbox({ checked, onChange, className, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === 'mixed';
  }, [checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={cx('k-cb', className)}
      checked={checked === true}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
      {...rest}
    />
  );
}
