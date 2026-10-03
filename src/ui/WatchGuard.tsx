import { useEffect, useState } from 'react';
import { useVault } from './vault-state.ts';
import { useWatchRuntime } from './watch-runtime.ts';
import { connectionLabel } from './watch-labels.ts';

/**
 * Mode B on every screen (SPEC 3.4, BUNNDLY-35, D-039): the status follows the watcher's
 * events at once; losing the connection while armed shows a red banner and repeats a
 * tone until the connection is back or the user mutes it; closing the tab while armed
 * asks the browser to confirm.
 */
export function WatchGuard() {
  const { client, status, refresh } = useVault();
  const { alarm, alarmRepeatMs } = useWatchRuntime();
  const watch = status?.watch ?? null;
  const armed = watch?.armed ?? false;
  const lostIn =
    watch !== null &&
    watch.armed &&
    (watch.connection === 'reconnecting' || watch.connection === 'disconnected')
      ? watch
      : null;
  const lost = lostIn !== null;
  const [muted, setMuted] = useState(false);
  // A new loss sounds again even if the last one was muted.
  const [wasLost, setWasLost] = useState(lost);
  if (wasLost !== lost) {
    setWasLost(lost);
    if (!lost) setMuted(false);
  }

  // Watcher events are rare (connection changes, detections): each re-reads the status.
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.kind === 'watch') void refresh();
      }),
    [client, refresh],
  );

  useEffect(() => {
    if (!lost || muted) return;
    alarm.beep();
    const timer = setInterval(() => {
      alarm.beep();
    }, alarmRepeatMs);
    return () => {
      clearInterval(timer);
    };
  }, [lost, muted, alarm, alarmRepeatMs]);

  // Closing the tab disarms the watcher with it.
  useEffect(() => {
    if (!armed) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [armed]);

  if (lostIn === null) return null;
  return (
    <div className="notice error alarm" role="alert">
      <p>
        <strong>Utracono połączenie z Helius przy uzbrojonym watcherze.</strong>{' '}
        {connectionLabel(lostIn.connection, lostIn.attempt)}. Nowe tokeny nie są teraz wykrywane; po
        połączeniu przerwa zostanie nadrobiona.
      </p>
      {!muted && (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setMuted(true);
            }}
          >
            Wycisz
          </button>
        </div>
      )}
    </div>
  );
}
