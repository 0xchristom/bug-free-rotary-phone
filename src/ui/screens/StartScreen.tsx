import { useId, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../../core/errors.ts';
import { Button, Input, ProgressBar } from '../kit/index.ts';
import { confirmForget, useRememberedView } from '../remember-view.ts';
import { useVault } from '../vault-state.ts';

export interface StartScreenProps {
  readonly onCreate: () => void;
  readonly onOpen: () => void;
}

const FORGET_CONFIRM =
  'Forget this fleet on this device? The fleet file on your disk stays as it is. Without that file you cannot open the fleet again.';

/**
 * Start: create or open a fleet. A fleet remembered on this device (BUNNDLY-52) opens
 * with the password alone; "Forget this device" removes it from the browser.
 */
export function StartScreen({ onCreate, onOpen }: StartScreenProps) {
  const { client, refresh } = useVault();
  const ids = useId();
  const { view, reload } = useRememberedView();
  const [password, setPassword] = useState('');
  /** scrypt progress 0..1 while unlocking, null otherwise. */
  const [unlocking, setUnlocking] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const account = view?.account ?? null;

  const unlock = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (password === '' || unlocking !== null) return;
    const secret = password;
    setPassword(''); // cleared after every attempt, successful or not
    setProblem(null);
    setUnlocking(0);
    try {
      await client.request(
        { type: 'unlockRemembered', password: secret },
        { onProgress: setUnlocking },
      );
      await refresh(); // the shell moves to the fleet
    } catch (e) {
      setProblem(toUserMessage(e));
      setUnlocking(null);
    }
  };

  const forget = async (): Promise<void> => {
    if (!(await confirmForget(client, FORGET_CONFIRM))) return;
    setProblem(null);
    try {
      await client.request({ type: 'forget' });
    } catch (e) {
      setProblem(toUserMessage(e));
    }
    reload();
  };

  if (account === null) {
    return (
      <section className="screen narrow panel hero" aria-labelledby="start-title">
        <h2 id="start-title">Welcome to Bunndly</h2>
        <p>Create a new fleet of wallets or open a saved fleet file.</p>
        <div className="actions">
          <Button variant="primary" onClick={onCreate}>
            Create a new fleet
          </Button>
          <Button onClick={onOpen}>Open a fleet file</Button>
        </div>
      </section>
    );
  }

  const percent = unlocking === null ? null : Math.round(unlocking * 100);
  return (
    <section className="screen narrow panel hero" aria-labelledby="start-title">
      <h2 id="start-title">Welcome back</h2>
      <p>
        <strong>{account.fleetName}</strong> ({account.walletCount}{' '}
        {account.walletCount === 1 ? 'wallet' : 'wallets'}) is remembered on this device. Enter the
        password to open it.
      </p>
      {problem && (
        <p className="notice error" role="alert">
          {problem}
        </p>
      )}
      <form className="form" onSubmit={(e) => void unlock(e)} noValidate>
        <label htmlFor={`${ids}-pw`}>Password</label>
        <Input
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
            <ProgressBar label="Decryption progress" value={percent} max={100} tone="run" />
            <p className="muted">Decrypting the fleet… {percent}%</p>
          </>
        )}
        <div className="actions">
          <Button type="submit" variant="primary" disabled={password === '' || percent !== null}>
            Unlock
          </Button>
          <Button variant="ghost" disabled={percent !== null} onClick={() => void forget()}>
            Forget this device
          </Button>
        </div>
      </form>
      <div className="actions">
        <Button disabled={percent !== null} onClick={onOpen}>
          Open another fleet file
        </Button>
        <Button disabled={percent !== null} onClick={onCreate}>
          Create a new fleet
        </Button>
      </div>
    </section>
  );
}
