import { cloneElement, useId, useState, type ReactElement } from 'react';

export interface TooltipProps {
  readonly text: string;
  /** One focusable control; the tooltip becomes its description while shown. */
  readonly children: ReactElement<{ 'aria-describedby'?: string | undefined }>;
}

/** A hint on hover and on keyboard focus. Esc hides it without moving the focus. */
export function Tooltip({ text, children }: TooltipProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const show = (): void => {
    setShown(true);
  };
  const hide = (): void => {
    setShown(false);
  };
  return (
    // The wrapper only watches hover and focus of the control inside it.
    <span
      className="k-tip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide();
      }}
    >
      {cloneElement(children, { 'aria-describedby': shown ? id : undefined })}
      {shown && (
        <span role="tooltip" id={id} className="k-tip">
          {text}
        </span>
      )}
    </span>
  );
}
