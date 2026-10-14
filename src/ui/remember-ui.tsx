/**
 * Components for the fleet remembered on this device (BUNNDLY-52): the "remember" option
 * of the wizard and the open screen, and "This device" in Settings. State and constants
 * are in remember-view.ts.
 */
import { useId, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { RememberedView, VaultRequest } from '../worker/protocol.ts';
import { Button, Checkbox } from './kit/index.ts';
import { UNAVAILABLE_HINT, WINDOW_OPTIONS, useRememberedView } from './remember-view.ts';
import { useVault } from './vault-state.ts';

export interface RememberOptionProps {
  readonly view: RememberedView | null;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}

const FORGET_CONFIRM_SETTINGS =
  'Forget this fleet on this device? The fleet file on your disk stays as it is. Next time you open the fleet from that file.';

/**
 * Settings, "This device": remember the open fleet and for how long it opens without the
 * password after a refresh. Saved at once in the worker, not in the fleet file.
 */
export function DeviceSettings() {
  const { client } = useVault();
  const ids = useId();
  const { view, reload } = useRememberedView();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (view === null) return null;
  const unavailable = !view.available;
  const { remember, windowMs } = view.prefs;

  const run = async (request: VaultRequest): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await client.request(request);
    } catch (e) {
      setProblem(toUserMessage(e));
    }
    reload();
    setBusy(false);
  };
  const windowIndex = WINDOW_OPTIONS.findIndex((o) => o.ms === windowMs);

  return (
    <section className="device-settings" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`}>This device</h3>
      {unavailable && <p className="hint">{UNAVAILABLE_HINT}</p>}
      <label className="checkbox">
        <Checkbox
          checked={remember && !unavailable}
          disabled={busy || unavailable}
          onChange={(checked) => {
            void run({ type: 'setRemember', remember: checked, windowMs });
          }}
        />
        Remember this fleet on this device
      </label>
      <label htmlFor={`${ids}-window`}>Open without the password after a refresh for</label>
      <select
        className="k-input"
        id={`${ids}-window`}
        value={String(windowIndex)}
        disabled={busy || unavailable || !remember}
        aria-describedby={`${ids}-window-hint`}
        onChange={(e) => {
          const option = WINDOW_OPTIONS[Number(e.target.value)];
          if (option) void run({ type: 'setRemember', remember, windowMs: option.ms });
        }}
      >
        {WINDOW_OPTIONS.map((o, i) => (
          <option key={o.label} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="hint" id={`${ids}-window-hint`}>
        Meanwhile anyone using this browser profile, or code running on this page, can open the
        fleet without the password. Lock ends it at once, and the auto-lock ends a timed window.
      </p>
      {problem && (
        <p className="notice error" role="alert">
          {problem}
        </p>
      )}
      <div className="actions">
        <Button
          variant="ghost"
          disabled={busy || unavailable || view.account === null}
          onClick={() => {
            if (window.confirm(FORGET_CONFIRM_SETTINGS)) void run({ type: 'forget' });
          }}
        >
          Forget this device
        </Button>
      </div>
    </section>
  );
}

/** "Remember this fleet on this device" with what it means. */
export function RememberOption({ view, checked, onChange, disabled = false }: RememberOptionProps) {
  const unavailable = view !== null && !view.available;
  return (
    <>
      <label className="checkbox">
        <Checkbox checked={checked} disabled={disabled || unavailable} onChange={onChange} />
        Remember this fleet on this device
      </label>
      <p className="hint">
        {unavailable
          ? UNAVAILABLE_HINT
          : 'The browser keeps the encrypted fleet file, so next time you only enter the password. It never keeps the password, the recovery phrase or the wallet keys.'}
      </p>
    </>
  );
}
