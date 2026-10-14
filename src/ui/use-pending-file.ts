import { useEffect, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { saveKeystoreFile, type StorageEnv } from '../storage/keystore-file.ts';
import type { PendingFile } from '../worker/protocol.ts';
import type { VaultClient } from '../worker/vault-client.ts';

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `The file “${fileName}” already exists in the chosen folder. Replace it with the updated fleet file?`,
  );
}

/**
 * Tells the vault that `fileText` is on disk now. Sent before the screen drops its own
 * unsaved file, so the next `pendingFile` question is answered after it (one queue).
 */
export function reportSaved(client: VaultClient, fileText: string): void {
  client.request({ type: 'fileSaved', fileText }).catch(() => undefined);
}

export interface PendingFileState {
  /** The open fleet's newest file when no file on disk matches it; null otherwise. */
  readonly file: PendingFile | null;
  readonly saving: boolean;
  /** A failed save, or the name of the file just written. */
  readonly message: { readonly kind: 'error' | 'saved'; readonly text: string } | null;
  readonly save: () => void;
}

/**
 * The fleet file the vault holds but the disk does not (BUNNDLY-80): a new fleet or a
 * change not saved before a reload, a lock or a screen left without saving. The vault
 * keeps the mark with the remembered fleet, so it survives a reload. Asked again whenever
 * a fleet opens and whenever no screen holds a newer unsaved file of its own (`held`).
 */
export function usePendingFile(
  client: VaultClient,
  /** Identifies the open fleet; null while locked. */
  openFleet: string | null,
  held: boolean,
  storage: StorageEnv,
): PendingFileState {
  const [file, setFile] = useState<PendingFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<PendingFileState['message']>(null);

  // Null while locked or while a screen holds its own newer file: nothing to ask then.
  const asked = openFleet === null || held ? null : openFleet;
  const [seen, setSeen] = useState({ asked, openFleet });
  if (seen.asked !== asked || seen.openFleet !== openFleet) {
    setSeen({ asked, openFleet });
    setFile(null); // the last answer is stale until the vault answers again
    // Another fleet, or none: what was said about the last one is obsolete.
    if (seen.openFleet !== openFleet) setMessage(null);
  }

  useEffect(() => {
    if (asked === null) return;
    let active = true;
    client.request({ type: 'pendingFile' }).then(
      (next) => {
        if (active) setFile(next);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [client, asked]);

  const save = (): void => {
    if (file === null || saving) return;
    const current = file;
    setSaving(true);
    setMessage(null);
    saveKeystoreFile(current.fileText, current.fleetName, storage, { confirmOverwrite })
      .then(async (result) => {
        // fileSaved answers what is still pending: a newer change made meanwhile stays.
        const next = await client.request({ type: 'fileSaved', fileText: current.fileText });
        setFile(next);
        setMessage({ kind: 'saved', text: `Saved ${result.fileName}.` });
      })
      .catch((e: unknown) => {
        setMessage({ kind: 'error', text: toUserMessage(e) });
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return { file, saving, message, save };
}
