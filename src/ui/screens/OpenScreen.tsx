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

const UNVERIFIED_HINT = 'Unverified address. Copy and the QR code are available after unlocking.';

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
          <strong>Warning: the fleet file may have been replaced.</strong>
        </p>
        <p>{problem.message}</p>
        <p>
          Do not send funds to the addresses from this file. Open your own copy of the file from a
          trusted place.
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
        <h2 id={`${ids}-title`}>Open a fleet file</h2>
        <p>
          Choose a “…keystore.json” file. You will see its preview first and enter the password
          after that.
        </p>
        {problemBox}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={phase.picking}
            onClick={() => void pick()}
          >
            {phase.picking ? 'Loading…' : 'Choose a fleet file'}
          </button>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </section>
    );
  }

  const { preview, unlocking } = phase;
  const percent = unlocking === null ? null : Math.round(unlocking * 100);
  return (
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Fleet preview</h2>
      <ul>
        <li>
          Fleet name: <strong>{preview.fleetName}</strong>
        </li>
        <li>
          Wallets: <strong>{preview.wallets.length}</strong>
        </li>
        <li>
          File: <strong>{phase.fileName}</strong>
        </li>
      </ul>
      <p className="notice warning" role="status">
        The addresses below come from the open part of the file and are not verified yet. Unlock the
        fleet with the password to check them, copy them or show a QR code.
      </p>

      {problemBox}
      <form className="form" onSubmit={(e) => void unlock(e)} noValidate>
        <label htmlFor={`${ids}-pw`}>Password</label>
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
            <progress max={100} value={percent} aria-label="Decryption progress" />
            <p className="muted">Decrypting the file… {percent}%</p>
          </>
        )}
        <div className="actions">
          <button type="submit" className="primary" disabled={password === '' || percent !== null}>
            Unlock
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
            Choose another file
          </button>
          <button type="button" disabled={percent !== null} onClick={onBack}>
            Back
          </button>
        </div>
      </form>

      <div className="table-wrap">
        <table className="wallets">
          <caption>Addresses from the file (unverified)</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Label</th>
              <th scope="col">Deposit address</th>
              <th scope="col">Actions</th>
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
                    unverified
                  </span>
                </td>
                <td>
                  <button type="button" disabled title={UNVERIFIED_HINT}>
                    Copy
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
