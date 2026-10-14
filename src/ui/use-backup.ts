/**
 * The backup folder on the page (BUNNDLY-62): the worker's view of it, kept fresh by its
 * `backup` events, and the click that gives the browser's access back. The page never
 * gets a file's content: only the state, the folder's name and the wallets without a
 * confirmed backup.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supportsDirectoryPicker, type StorageEnv } from '../storage/keystore-file.ts';
import type { VaultClient } from '../worker/vault-client.ts';
import type { BackupView } from '../worker/protocol.ts';

const FAILED_REASON = {
  permission: 'The browser did not give access to the folder.',
  write: 'A file could not be written to the folder.',
  verify: 'A file read back from the folder differs from what was written.',
} as const;

/** Why the rail says "failed", in words. */
export function backupFailure(reason: keyof typeof FAILED_REASON): string {
  return FAILED_REASON[reason];
}

export interface BackupRail {
  /** null until the worker answers, and while the fleet is locked. */
  readonly view: BackupView | null;
  /** The browser has no folder access (Firefox, Safari): the user saves the file by hand. */
  readonly manual: boolean;
  /** Asks the browser for the folder again (needs this click), then writes. */
  readonly reconnect: () => Promise<void>;
}

/** The handle as the page uses it: Chromium asks the user from a click on the page. */
interface PermissionHandle {
  requestPermission?(descriptor: { readonly mode: 'readwrite' }): Promise<string>;
}

/** Wallets with no confirmed backup, for the table's "Not backed up" mark. */
export const NotBackedUpContext = createContext<ReadonlySet<number>>(new Set());

export function useNotBackedUp(index: number): boolean {
  return useContext(NotBackedUpContext).has(index);
}

/** `fileKey` changes with every new file of the open fleet (create, unlock, any change). */
export function useBackup(
  client: VaultClient,
  storage: StorageEnv,
  unlocked: boolean,
  fileKey: unknown,
): BackupRail {
  const [view, setView] = useState<BackupView | null>(null);
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.kind === 'backup') setView(event.view);
      }),
    [client],
  );
  useEffect(() => {
    if (!unlocked) return;
    let live = true;
    client.request({ type: 'backupStatus' }).then(
      (next) => {
        if (live) setView(next);
      },
      () => undefined, // the rail keeps what it showed; the next change asks again
    );
    return () => {
      live = false;
    };
  }, [client, unlocked, fileKey]);
  const reconnect = useCallback(async () => {
    const handle = (await client.request({ type: 'backupHandle' })) as PermissionHandle | null;
    if (handle === null) return;
    if (handle.requestPermission !== undefined) {
      const answer = await handle.requestPermission({ mode: 'readwrite' });
      if (answer !== 'granted') return;
    }
    setView(await client.request({ type: 'backupRetry' }));
  }, [client]);
  return {
    view: unlocked ? view : null,
    manual: !supportsDirectoryPicker(storage),
    reconnect,
  };
}
