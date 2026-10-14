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

/** Said before every action that would drop a remembered fleet the disk is behind on. */
const ONLY_IN_BROWSER =
  'The fleet file on your disk is older than this fleet, or was never saved: only this browser holds the latest changes.';

export const FORGET_UNSAVED_CONFIRM = `${ONLY_IN_BROWSER} Forgetting this device deletes them for good. Forget anyway?`;

/**
 * Opening a file or creating a fleet replaces the remembered fleet (or forgets it when
 * "remember" is off), so it asks with the sentence of "Forget this device" (BUNNDLY-84).
 */
export function replaceUnsavedConfirm(fleetName: string | null, action: 'open' | 'create'): string {
  const which =
    fleetName === null
      ? 'A fleet is remembered on this device.'
      : `“${fleetName}” is remembered on this device.`;
  const doing = action === 'open' ? 'Opening another fleet file' : 'Creating a new fleet';
  return `${which} ${ONLY_IN_BROWSER} ${doing} replaces it and deletes them for good. Continue anyway?`;
}

/** Shown after "No": nothing was sent, the remembered fleet is as it was. */
export const REPLACE_KEPT =
  'The remembered fleet was kept. Unlock it on the start screen and save its fleet file first.';

/**
 * Asks before a file is opened or a fleet is created while the remembered fleet holds
 * changes the disk does not have (BUNNDLY-84); true when there is nothing to lose or the
 * user agrees. Read fresh from the vault, like `confirmForget`.
 */
export async function confirmReplace(
  client: VaultClient,
  action: 'open' | 'create',
): Promise<boolean> {
  let account: RememberedView['account'];
  try {
    account = (await client.request({ type: 'remembered' })).account;
  } catch {
    // unknown is treated as the risky case
    return window.confirm(replaceUnsavedConfirm(null, action));
  }
  if (account === null || !account.unsaved) return true;
  return window.confirm(replaceUnsavedConfirm(account.fleetName, action));
}

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
