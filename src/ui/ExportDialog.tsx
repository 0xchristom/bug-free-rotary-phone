import { useId, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { downloadTextFile, type StorageEnv } from '../storage/keystore-file.ts';
import { useVault } from './vault-state.ts';

export interface ExportDialogProps {
  readonly storage: StorageEnv;
  readonly onClose: () => void;
}

const CONFIRM_LABEL = 'Rozumiem, że ten plik daje pełny dostęp do środków';

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
    <section className="dialog notice error" role="dialog" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`}>Eksport jawny: mnemonik i klucze prywatne</h3>
      <p>
        Plik będzie zawierał mnemonik i klucze prywatne wszystkich portfeli w czystym tekście.
        Każdy, kto go zobaczy, może zabrać wszystkie środki z floty. Zapisz go offline (np. na
        pendrive w sejfie), nie wysyłaj nikomu i nie trzymaj w chmurze.
      </p>
      {doneFile ? (
        <>
          <p role="status">
            Pobrano plik {doneFile}. Sprawdź folder „Pobrane” i przenieś go w bezpieczne miejsce.
          </p>
          <div className="actions">
            <button type="button" onClick={onClose}>
              Zamknij
            </button>
          </div>
        </>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)} noValidate>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
              }}
            />
            {CONFIRM_LABEL}
          </label>
          <label htmlFor={`${ids}-pw`}>Hasło floty (wpisz ponownie)</label>
          <input
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
                {f === 'txt' ? 'Tekst (.txt)' : 'JSON (.json)'}
              </label>
            ))}
          </div>
          {busy && <p className="muted">Sprawdzam hasło…</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button
              type="submit"
              className="danger"
              disabled={!confirmed || password === '' || busy}
            >
              Pobierz eksport jawny
            </button>
            <button type="button" onClick={onClose} disabled={busy}>
              Anuluj
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
