import { useCallback, useState } from 'react';
import { isAppError, toUserMessage } from '../core/errors.ts';
import type { Network } from '../core/network.ts';
import { saveKeystoreFile, type StorageEnv } from '../storage/keystore-file.ts';
import type { VaultClient } from '../worker/vault-client.ts';
import type { VaultStatus } from '../worker/protocol.ts';
import { reportSaved } from './use-pending-file.ts';

const BUY_RUNNING =
  'The network cannot change during a buy. Wait until it ends or stop it with STOP.';
const WATCH_ARMED = 'The network cannot change while the watcher is armed. Disarm it first.';
const FILE_UNSAVED =
  'Save the table changes and the updated fleet file first, then change the network.';

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `The file “${fileName}” already exists in the chosen folder. Replace it with the updated fleet file?`,
  );
}

/** The fleet file with the new network, waiting to be written (or already written). */
export type NetworkFile =
  | {
      readonly kind: 'unsaved';
      readonly fileText: string;
      readonly fleetName: string;
      readonly network: Network;
      /** The network in the file on disk: going back to it leaves nothing to save. */
      readonly onDisk: Network;
      readonly saving: boolean;
    }
  | { readonly kind: 'saved'; readonly fileName: string };

export interface NetworkSwitching {
  readonly file: NetworkFile | null;
  /** Why the last click changed nothing, or a failed save. */
  readonly message: string | null;
  /** True while the file with the new network is not written yet. */
  readonly unsaved: boolean;
  readonly choose: (network: Network) => void;
  readonly save: () => void;
  /** Lock, or a newer fleet file from a screen: the file kept here is obsolete. */
  readonly drop: () => void;
}

/**
 * Switching the fleet's network from the header (BUNNDLY-44, D-041). The choice is a
 * fleet setting: the vault applies it at once and returns the new file text, which waits
 * here until the user writes it. Nothing changes while a buy runs, the watcher is armed or
 * a screen holds an unsaved fleet file (that file would not know the new network).
 */
export function useNetworkSwitch(
  client: VaultClient,
  status: VaultStatus | null,
  screenUnsaved: boolean,
  storage: StorageEnv,
  refresh: () => Promise<void>,
): NetworkSwitching {
  const [file, setFile] = useState<NetworkFile | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The file is written (or the screen left): the request to save it first is obsolete.
  if (message === FILE_UNSAVED && !screenUnsaved) setMessage(null);

  const choose = (network: Network): void => {
    if (status === null || status.info === null || busy || network === status.network) return;
    if (status.buy !== null) {
      setMessage(BUY_RUNNING);
      return;
    }
    if (status.watch?.armed) {
      setMessage(WATCH_ARMED);
      return;
    }
    if (screenUnsaved) {
      setMessage(FILE_UNSAVED);
      return;
    }
    // Buying is off on devnet, so DRY-RUN may be off unnoticed: say what mainnet means.
    if (
      network === 'mainnet' &&
      !status.info.settings.global.dryRun &&
      !window.confirm(
        'You are switching to Mainnet with DRY-RUN off: a buy will send real transactions and spend SOL. Switch to Mainnet?',
      )
    ) {
      return;
    }
    const onDisk = file?.kind === 'unsaved' ? file.onDisk : status.network;
    setMessage(null);
    setBusy(true);
    client
      .request({ type: 'setNetwork', network })
      .then(async (result) => {
        setFile(
          network === onDisk
            ? null
            : {
                kind: 'unsaved',
                fileText: result.fileText,
                fleetName: result.info.fleetName,
                network,
                onDisk,
                saving: false,
              },
        );
        await refresh();
      })
      .catch((e: unknown) => {
        setMessage(
          isAppError(e) && e.code === 'BUY_RUNNING'
            ? BUY_RUNNING
            : isAppError(e) && e.code === 'WATCH_ARMED'
              ? WATCH_ARMED
              : toUserMessage(e),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const save = (): void => {
    if (file?.kind !== 'unsaved' || file.saving) return;
    const current = file;
    setMessage(null);
    setFile({ ...current, saving: true });
    saveKeystoreFile(current.fileText, current.fleetName, storage, { confirmOverwrite }).then(
      (result) => {
        reportSaved(client, current.fileText);
        setFile((f) => (f === null ? null : { kind: 'saved', fileName: result.fileName }));
      },
      (e: unknown) => {
        setMessage(toUserMessage(e));
        setFile((f) => (f === null ? null : { ...current, saving: false }));
      },
    );
  };

  const drop = useCallback(() => {
    setFile(null);
    setMessage(null);
  }, []);

  return { file, message, unsaved: file?.kind === 'unsaved', choose, save, drop };
}
