import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { AppError, toUserMessage } from '../core/errors.ts';
import type { StorageEnv } from '../storage/keystore-file.ts';
import type { BackupView } from '../worker/protocol.ts';
import { Button, Checkbox, Input } from './kit/index.ts';
import { backupFailure } from './use-backup.ts';
import { useVault } from './vault-state.ts';

export interface BackupDialogProps {
  readonly storage: StorageEnv;
  readonly onClose: () => void;
}

export const BACKUP_CONFIRM_LABEL =
  'I understand that the plain-text file in this folder gives full access to the funds';

/**
 * Turns the backup folder on (BUNNDLY-62, SPEC 11.1): the warning about the plain-text key
 * file, its confirmation and the password typed again. The folder is chosen first, in the
 * click (the browser asks only from one); then the vault checks the password with a full
 * derivation and writes both files. From then on every change is written without asking.
 */
export function BackupDialog({ storage, onClose }: BackupDialogProps) {
  const { client } = useVault();
  const ids = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BackupView | null>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const pick = storage.showDirectoryPicker;
    if (!confirmed || password === '' || busy || pick === undefined) return;
    const secret = password;
    setPassword(''); // cleared after every attempt
    setError(null);
    setBusy(true);
    try {
      let handle;
      try {
        handle = await pick({ id: 'bunndly-backup', mode: 'readwrite' });
      } catch {
        throw new AppError('STORAGE_CANCELLED');
      }
      const view = await client.request({ type: 'enableBackup', handle, password: secret });
      if (view.state.kind === 'failed') setError(backupFailure(view.state.reason));
      else setDone(view);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      ref={dialog}
      className="panel danger-panel"
      role="dialog"
      aria-labelledby={`${ids}-title`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <h3 id={`${ids}-title`}>Backup folder</h3>
      <p>
        After every change of the fleet the app writes two files to this folder: the encrypted fleet
        file and a file with the recovery phrase and the private keys of all wallets in plain text.
        Anyone and any program with access to this folder can take all funds from the fleet. Do not
        choose a folder synced to the cloud (OneDrive, Google Drive, Dropbox, iCloud).
      </p>
      {done ? (
        <>
          <p role="status">
            Backup saved to the folder “{done.state.kind === 'off' ? '' : done.state.folder}”. Every
            change is written there from now on.
          </p>
          <div className="actions">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)} noValidate>
          <label className="checkbox">
            <Checkbox
              checked={confirmed}
              onChange={(checked) => {
                setConfirmed(checked);
              }}
            />
            {BACKUP_CONFIRM_LABEL}
          </label>
          <label htmlFor={`${ids}-pw`}>Fleet password (type it again)</label>
          <Input
            id={`${ids}-pw`}
            type="password"
            value={password}
            autoComplete="current-password"
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          {busy && <p className="muted">Checking the password and writing the files…</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <Button type="submit" variant="danger" disabled={!confirmed || password === '' || busy}>
              Choose the folder and turn on
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
