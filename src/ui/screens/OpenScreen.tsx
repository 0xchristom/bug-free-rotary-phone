import { useId, useState, type SyntheticEvent } from 'react';
import { isAppError, toUserMessage } from '../../core/errors.ts';
import { openKeystoreFile, type StorageEnv } from '../../storage/keystore-file.ts';
import type { VaultPreview } from '../../worker/protocol.ts';
import { useVault } from '../vault-state.ts';

type Phase =
  | { readonly kind: 'pick'; readonly picking: boolean }
  | {
      readonly kind: 'preview';
      readonly fileName: string;
      readonly fileText: string;
      readonly preview: VaultPreview;
      /** scrypt progress 0..1 while unlocking, null otherwise. */
      readonly unlocking: number | null;
    };

/** Problem to show: a regular message, or the tampered-file warning. */
type Problem = { readonly kind: 'error' | 'tampered'; readonly message: string } | null;

export interface OpenScreenProps {
  readonly storage: StorageEnv;
  readonly onBack: () => void;
  /** The fleet is unlocked and the vault status refreshed. */
  readonly onUnlocked: () => void;
}

const UNVERIFIED_HINT =
  'Adres niezweryfikowany. Kopiowanie i kod QR będą dostępne po odblokowaniu.';

/**
 * Opening a keystore file (SPEC 3.1): pick the file, preview its public part without the
 * password, then unlock it in the vault worker. Before unlocking, the addresses come only
 * from the unencrypted part of the file, which anyone could edit, so they are marked
 * "niezweryfikowany" and cannot be copied or shown as QR (D-018). The password field is
 * cleared after every attempt.
 */
export function OpenScreen({ storage, onBack, onUnlocked }: OpenScreenProps) {
  const { client, refresh } = useVault();
  const ids = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'pick', picking: false });
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem>(null);

  const pick = async (): Promise<void> => {
    setProblem(null);
    setPhase({ kind: 'pick', picking: true });
    try {
      const file = await openKeystoreFile(storage);
      const preview = await client.request({ type: 'preview', fileText: file.text });
      setPhase({
        kind: 'preview',
        fileName: file.name,
        fileText: file.text,
        preview,
        unlocking: null,
      });
    } catch (e) {
      setProblem({ kind: 'error', message: toUserMessage(e) });
      setPhase({ kind: 'pick', picking: false });
    }
  };

  const unlock = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (phase.kind !== 'preview' || password === '' || phase.unlocking !== null) return;
    const secret = password;
    setPassword(''); // cleared after every attempt, successful or not
    setProblem(null);
    const current = phase;
    setPhase({ ...current, unlocking: 0 });
    try {
      await client.request(
        { type: 'unlock', fileText: current.fileText, password: secret },
        {
          onProgress: (progress) => {
            setPhase({ ...current, unlocking: progress });
          },
        },
      );
      await refresh();
      onUnlocked();
    } catch (e) {
      setProblem({
        kind: isAppError(e) && e.code === 'KEYSTORE_TAMPERED' ? 'tampered' : 'error',
        message: toUserMessage(e),
      });
      setPhase({ ...current, unlocking: null });
    }
  };

  const problemBox =
    problem &&
    (problem.kind === 'tampered' ? (
      <div className="notice error" role="alert">
        <p>
          <strong>Uwaga: plik floty mógł zostać podmieniony.</strong>
        </p>
        <p>{problem.message}</p>
        <p>
          Nie wysyłaj środków na adresy z tego pliku. Otwórz własną kopię pliku z zaufanego miejsca.
        </p>
      </div>
    ) : (
      <p className="notice error" role="alert">
        {problem.message}
      </p>
    ));

  if (phase.kind === 'pick') {
    return (
      <section className="screen" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Otwórz plik floty</h2>
        <p>Wybierz plik „…keystore.json”. Najpierw zobaczysz jego podgląd, hasło podasz potem.</p>
        {problemBox}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={phase.picking}
            onClick={() => void pick()}
          >
            {phase.picking ? 'Wczytywanie…' : 'Wybierz plik floty'}
          </button>
          <button type="button" onClick={onBack}>
            Wróć
          </button>
        </div>
      </section>
    );
  }

  const { preview, unlocking } = phase;
  const percent = unlocking === null ? null : Math.round(unlocking * 100);
  return (
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Podgląd floty</h2>
      <ul>
        <li>
          Nazwa floty: <strong>{preview.fleetName}</strong>
        </li>
        <li>
          Portfele: <strong>{preview.wallets.length}</strong>
        </li>
        <li>
          Plik: <strong>{phase.fileName}</strong>
        </li>
      </ul>
      <p className="notice warning" role="status">
        Adresy poniżej pochodzą z jawnej części pliku i nie są jeszcze zweryfikowane. Odblokuj flotę
        hasłem, żeby je sprawdzić, skopiować albo pokazać kod QR.
      </p>

      {problemBox}
      <form className="form" onSubmit={(e) => void unlock(e)} noValidate>
        <label htmlFor={`${ids}-pw`}>Hasło</label>
        <input
          id={`${ids}-pw`}
          type="password"
          value={password}
          autoComplete="current-password"
          disabled={percent !== null}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        {percent !== null && (
          <>
            <progress max={100} value={percent} aria-label="Postęp odszyfrowania" />
            <p className="muted">Odszyfrowuję plik… {percent}%</p>
          </>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={password === '' || percent !== null}>
            Odblokuj
          </button>
          <button
            type="button"
            disabled={percent !== null}
            onClick={() => {
              setPassword('');
              setProblem(null);
              setPhase({ kind: 'pick', picking: false });
            }}
          >
            Wybierz inny plik
          </button>
          <button type="button" disabled={percent !== null} onClick={onBack}>
            Wróć
          </button>
        </div>
      </form>

      <div className="table-wrap">
        <table className="wallets">
          <caption>Adresy z pliku (niezweryfikowane)</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Etykieta</th>
              <th scope="col">Adres depozytu</th>
              <th scope="col">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {preview.wallets.map((w) => (
              <tr key={w.index}>
                <td>{w.index + 1}</td>
                <td>{w.label}</td>
                <td>
                  <code className="address">{w.address}</code>{' '}
                  <span className="badge unverified" title={UNVERIFIED_HINT}>
                    niezweryfikowany
                  </span>
                </td>
                <td>
                  <button type="button" disabled title={UNVERIFIED_HINT}>
                    Kopiuj
                  </button>{' '}
                  <button type="button" disabled title={UNVERIFIED_HINT}>
                    QR
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
