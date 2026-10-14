import { useId } from 'react';
import { EVERY_MAX_S, EVERY_MIN_S, parseEvery, parsePerStep } from './stairs-plan.ts';

export interface StairsStripProps {
  readonly every: string;
  readonly perStep: string;
  readonly onEvery: (text: string) => void;
  readonly onPerStep: (text: string) => void;
  /** "→ 5 steps, last one at +24.0 s" (`planText`); empty without wallets. */
  readonly plan: string;
  readonly disabled?: boolean;
}

/**
 * Stairs fields in the toolbar (BUNNDLY-61, mockup v2): "every N s · M per step" and the plan
 * of the selected wallets. A value out of range marks its field; the commands say why they
 * are off (`stairsProblem` in stairs-plan.ts).
 */
export function StairsStrip({
  every,
  perStep,
  onEvery,
  onPerStep,
  plan,
  disabled = false,
}: StairsStripProps) {
  const ids = useId();
  const everyBad = parseEvery(every) === null;
  const perBad = parsePerStep(perStep) === null;
  return (
    <div className="stairs" role="group" aria-label="Stairs steps">
      every
      <input
        id={`${ids}-every`}
        type="text"
        inputMode="numeric"
        aria-label="Seconds between steps"
        aria-invalid={everyBad}
        title={`${String(EVERY_MIN_S)} to ${String(EVERY_MAX_S)} seconds`}
        value={every}
        disabled={disabled}
        onChange={(e) => {
          onEvery(e.target.value);
        }}
      />
      s ·
      <input
        id={`${ids}-per`}
        type="text"
        inputMode="numeric"
        aria-label="Wallets per step"
        aria-invalid={perBad}
        title="At least 1 wallet per step"
        value={perStep}
        disabled={disabled}
        onChange={(e) => {
          onPerStep(e.target.value);
        }}
      />
      per step
      <span className="plan" data-testid="stairs-plan">
        {plan}
      </span>
    </div>
  );
}
