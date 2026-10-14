/**
 * The fleet remembered on this device (BUNNDLY-52) as the UI sees it: the view the vault
 * worker gives (public data only), the window lengths for Settings and the value of the
 * "remember" option. The components are in remember-ui.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import type { RememberedView } from '../worker/protocol.ts';
import type { VaultClient } from '../worker/vault-client.ts';
import { useVault } from './vault-state.ts';

const MINUTE_MS = 60_000;

/** The window lengths in Settings, in the order shown; null: no time limit. */
export const WINDOW_OPTIONS: readonly { readonly ms: number | null; readonly label: string }[] = [
  { ms: 15 * MINUTE_MS, label: '15 minutes' },
  { ms: 60 * MINUTE_MS, label: '1 hour' },
  { ms: 120 * MINUTE_MS, label: '2 hours' },
  { ms: null, label: 'No time limit' },
];

export const UNAVAILABLE_HINT =
  'This browser does not let the page keep data (for example in a private window), so the fleet cannot be remembered here.';

const UNAVAILABLE: RememberedView = {
  available: false,
  account: null,
  prefs: { remember: false, windowMs: null },
};

/** The remembered fleet and the device settings; null until the worker answers. */
export function useRememberedView(): {
  readonly view: RememberedView | null;
  readonly reload: () => void;
} {
  const { client } = useVault();
  const [view, setView] = useState<RememberedView | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    client.request({ type: 'remembered' }).then(
      (next) => {
        if (active) setView(next);
      },
      () => {
        if (active) setView(UNAVAILABLE);
      },
    );
    return () => {
      active = false;
    };
  }, [client, version]);
  const reload = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);
  return { view, reload };
}

export const FORGET_UNSAVED_CONFIRM =
  'The fleet file on your disk is older than this fleet, or was never saved: only this browser holds the latest changes. Forgetting this device deletes them for good. Forget anyway?';

/**
 * Asks before the remembered fleet is removed: `usual` while the disk holds its file (null:
 * no question then), the stronger question while only the browser does (BUNNDLY-80). Read
 * fresh from the vault, since a change made after the view was read may have left the disk
 * behind.
 */
export async function confirmForget(client: VaultClient, usual: string | null): Promise<boolean> {
  let unsaved = true; // unknown is treated as the risky case
  try {
    unsaved = (await client.request({ type: 'remembered' })).account?.unsaved ?? false;
  } catch {
    // keep the stronger question
  }
  if (unsaved) return window.confirm(FORGET_UNSAVED_CONFIRM);
  return usual === null || window.confirm(usual);
}

/**
 * The value for `remember` in create and unlock: the user's tick, or the device setting
 * until they touch it; false where the browser keeps nothing.
 */
export function rememberChoice(view: RememberedView | null, ticked: boolean | null): boolean {
  if (view !== null && !view.available) return false;
  return ticked ?? view?.prefs.remember ?? true;
}
