import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { downloadTextFile, type StorageEnv } from '../storage/keystore-file.ts';
import { useVault } from './vault-state.ts';
import { Button, Checkbox, Input } from './kit/index.ts';

export interface ExportDialogProps {
  readonly storage: StorageEnv;
  readonly onClose: () => void;
}

const CONFIRM_LABEL = 'I understand that this file gives full access to the funds';

/**
 * Plain export of the mnemonic and private keys (SPEC 3.1, D-023): only after the warning
 * is confirmed and the password typed again. The vault checks the password by decrypting
 * the fleet file; the content goes straight into a download and is never kept in React
 * state. This is also the only way to back up the mnemonic.
 */
export function ExportDialog({ storage, onClose }: ExportDialogProps) {
  const { client } = useVault();
  const ids = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState('');
  const [format, setFormat] = useState<'txt' | 'json'>('txt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneFile, setDoneFile] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);

  // Focus moves into the dialog, so Escape reaches it; on close it goes back to the opener.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!confirmed || password === '' || busy) return;
    const secret = password;
    setPassword(''); // cleared after every attempt
    setError(null);
    setBusy(true);
    try {
      const res = await client.request({ type: 'exportPlain', password: secret, format });
      // Straight to the download; only the file name is kept.
      downloadTextFile(storage, res.text, res.fileName, res.mimeType);
      setDoneFile(res.fileName);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // An inline dialog on purpose: the rest of the page stays usable while it is open.
    <section
      ref={dialog}
      className="panel danger-panel"
      role="dialog"
      aria-labelledby={`${ids}-title`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        // Escape is Cancel: it does not close the dialog while the password is checked.
        if (!busy) onClose();
      }}
    >
      <h3 id={`${ids}-title`}>Plain export: recovery phrase and private keys</h3>
      <p>
        The file will contain the recovery phrase and the private keys of all wallets in plain text.
        Anyone who sees it can take all funds from the fleet. Keep it offline (e.g. on a USB drive
        in a safe), never send it to anyone and do not keep it in the cloud.
      </p>
      {doneFile ? (
        <>
          <p role="status">
            Downloaded {doneFile}. Check the “Downloads” folder and move it to a safe place.
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
            {CONFIRM_LABEL}
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
          <p id={`${ids}-fmt`}>Format</p>
          <div role="radiogroup" aria-labelledby={`${ids}-fmt`} className="inline">
            {(['txt', 'json'] as const).map((f) => (
              <label key={f} className="checkbox">
                <input
                  type="radio"
                  name={`${ids}-fmt`}
                  checked={format === f}
                  onChange={() => {
                    setFormat(f);
                  }}
                />
                {f === 'txt' ? 'Text (.txt)' : 'JSON (.json)'}
              </label>
            ))}
          </div>
          {busy && <p className="muted">Checking the password…</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <Button type="submit" variant="danger" disabled={!confirmed || password === '' || busy}>
              Download the plain export
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
