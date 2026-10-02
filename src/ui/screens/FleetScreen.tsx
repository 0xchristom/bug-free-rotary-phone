import { useEffect, useId, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../../core/errors.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type SaveResult,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { VaultInfo } from '../../worker/protocol.ts';
import { AddressQr } from '../AddressQr.tsx';
import { useVault } from '../vault-state.ts';

const MAX_WALLETS = 100;

type AddPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'adding' }
  /** Wallets added in the vault; the updated file is not saved yet. */
  | {
      readonly kind: 'unsaved';
      readonly fileText: string;
      readonly fleetName: string;
      readonly added: number;
      readonly saving: boolean;
    }
  | { readonly kind: 'saved'; readonly result: SaveResult; readonly added: number };

export interface FleetScreenProps {
  readonly info: VaultInfo;
  readonly storage: StorageEnv;
  /** True while added wallets are not saved to the file yet. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `Plik „${fileName}” już istnieje w wybranym folderze. Zastąpić go zaktualizowanym plikiem floty?`,
  );
}

/**
 * Unlocked fleet: wallet addresses (verified by the vault on unlock) with copy and QR,
 * and "Dodaj portfele". The full table with balances comes in BUNNDLY-14.
 */
export function FleetScreen({ info, storage, onUnsavedChange }: FleetScreenProps) {
  const { client, refresh } = useVault();
  const ids = useId();
  const [qrFor, setQrFor] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [addCount, setAddCount] = useState('1');
  const [phase, setPhase] = useState<AddPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const unsaved = phase.kind === 'unsaved';
  useEffect(() => {
    onUnsavedChange(unsaved);
    return () => {
      onUnsavedChange(false); // unmounted (e.g. after a lock): nothing left to protect
    };
  }, [unsaved, onUnsavedChange]);

  const room = MAX_WALLETS - info.wallets.length;
  const count = Number(addCount);
  const countValid =
    addCount.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= room;

  const copy = async (index: number, address: string): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(address);
      setCopied(index);
    } catch {
      setCopied(null);
      setError('Nie udało się skopiować adresu. Zaznacz go i skopiuj ręcznie.');
    }
  };

  const add = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!countValid || phase.kind === 'adding' || phase.kind === 'unsaved') return;
    setError(null);
    setPhase({ kind: 'adding' });
    try {
      const result = await client.request({ type: 'addWallets', count });
      setPhase({
        kind: 'unsaved',
        fileText: result.fileText,
        fleetName: result.info.fleetName,
        added: count,
        saving: false,
      });
      setAddCount('1');
      await refresh();
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'idle' });
    }
  };

  const save = async (current: Extract<AddPhase, { kind: 'unsaved' }>): Promise<void> => {
    setError(null);
    setPhase({ ...current, saving: true });
    try {
      const result = await saveKeystoreFile(current.fileText, current.fleetName, storage, {
        confirmOverwrite,
      });
      setPhase({ kind: 'saved', result, added: current.added });
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ ...current, saving: false });
    }
  };

  return (
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Flota</h2>
      <p>
        Portfele we flocie: <strong>{info.wallets.length}</strong>
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="wallets">
          <caption>Adresy depozytu (zweryfikowane)</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Etykieta</th>
              <th scope="col">Adres depozytu</th>
              <th scope="col">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {info.wallets.map((w) => (
              <tr key={w.index}>
                <td>{w.index + 1}</td>
                <td>{w.label}</td>
                <td>
                  <code className="address">{w.address}</code>
                  {qrFor === w.index && (
                    <div className="qr-box">
                      <AddressQr address={w.address} />
                    </div>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={`Kopiuj adres ${w.label}`}
                    onClick={() => void copy(w.index, w.address)}
                  >
                    {copied === w.index ? 'Skopiowano' : 'Kopiuj'}
                  </button>{' '}
                  <button
                    type="button"
                    aria-label={`Kod QR ${w.label}`}
                    aria-expanded={qrFor === w.index}
                    onClick={() => {
                      setQrFor((current) => (current === w.index ? null : w.index));
                    }}
                  >
                    QR
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Dodaj portfele</h3>
      {phase.kind === 'unsaved' ? (
        <>
          <p className="notice warning" role="status">
            Nowe portfele: {phase.added}. Zaktualizowany plik floty nie jest jeszcze zapisany. Stary
            plik otworzy flotę bez nowych portfeli.
          </p>
          {!supportsDirectoryPicker(storage) && (
            <p className="muted">
              Twoja przeglądarka pobierze plik. Sprawdź potem folder „Pobrane”.
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={phase.saving}
              onClick={() => void save(phase)}
            >
              {phase.saving ? 'Zapisywanie…' : 'Zapisz zaktualizowany plik floty'}
            </button>
          </div>
        </>
      ) : room === 0 ? (
        <p className="muted">Flota ma już maksymalnie {MAX_WALLETS} portfeli.</p>
      ) : (
        <form className="form" onSubmit={(e) => void add(e)} noValidate>
          {phase.kind === 'saved' && (
            <p className="notice" role="status">
              Zapisano plik {phase.result.fileName} z nowymi portfelami.
            </p>
          )}
          <label htmlFor={`${ids}-add`}>Liczba nowych portfeli</label>
          <input
            id={`${ids}-add`}
            type="number"
            min={1}
            max={room}
            step={1}
            value={addCount}
            onChange={(e) => {
              setAddCount(e.target.value);
            }}
            aria-invalid={!countValid}
          />
          {!countValid && (
            <p className="field-error">
              Możesz dodać od 1 do {room} portfeli (łącznie najwyżej {MAX_WALLETS}).
            </p>
          )}
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={!countValid || phase.kind === 'adding'}
            >
              {phase.kind === 'adding' ? 'Dodawanie…' : 'Dodaj portfele'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
