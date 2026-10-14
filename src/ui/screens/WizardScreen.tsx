import { useId, useLayoutEffect, useState, type SyntheticEvent } from 'react';
import { ERROR_MESSAGES, toUserMessage } from '../../core/errors.ts';
import { MIN_PASSWORD_LENGTH, isValidFleetName } from '../../core/keystore/limits.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type SaveResult,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { VaultInfo } from '../../worker/protocol.ts';
import { ExportDialog } from '../ExportDialog.tsx';
import { passwordStrength } from '../password-strength.ts';
import { useVault } from '../vault-state.ts';
import { Button, Checkbox, Input, ProgressBar } from '../kit/index.ts';
import { RememberOption } from '../remember-ui.tsx';
import { rememberChoice, useRememberedView } from '../remember-view.ts';

export const DEFAULT_WALLET_COUNT = 30;
const MAX_WALLETS = 100;
const MNEMONIC_WORD_COUNTS: ReadonlySet<number> = new Set([12, 15, 18, 21, 24]);
const MNEMONIC_PATH = "m/44'/501'/{i}'/0'";

/** Form fields in screen order; the first one with a problem gets the focus on submit. */
const FIELDS = ['count', 'name', 'pw', 'pw2', 'mn'] as const;
type Field = (typeof FIELDS)[number];

type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'creating'; readonly progress: number }
  | {
      readonly kind: 'created';
      readonly fileText: string;
      readonly info: VaultInfo;
      readonly saving: boolean;
    }
  | { readonly kind: 'saved'; readonly result: SaveResult; readonly info: VaultInfo };

export interface WizardScreenProps {
  readonly storage: StorageEnv;
  /** Back to where the user came from (only before the fleet is created). */
  readonly onBack: () => void;
  /** Leave the wizard after the file is saved. */
  readonly onDone: () => void;
  /** True while a created fleet has not been saved to a file yet. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `The file “${fileName}” already exists in the chosen folder. Overwrite it?`,
  );
}

/**
 * Fleet wizard (SPEC 3.1): wallet count, fleet name, password with a strength meter and
 * an optional imported mnemonic. The fleet is created in the vault worker (scrypt with
 * progress); the encrypted file is saved only when the user clicks "Save the fleet file",
 * because the folder picker needs a fresh user gesture. The password and mnemonic are
 * cleared from the form as soon as they are sent to the worker.
 *
 * Every condition that blocks creation has a message next to its field. A message for an
 * untouched field appears after the user leaves that field or tries to create the fleet,
 * so an empty form does not open full of errors.
 */
export function WizardScreen({ storage, onBack, onDone, onUnsavedChange }: WizardScreenProps) {
  const { client, refresh } = useVault();
  const ids = useId();
  const [walletCount, setWalletCount] = useState(String(DEFAULT_WALLET_COUNT));
  const [fleetName, setFleetName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [importMnemonic, setImportMnemonic] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<Field>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const { view: remembered } = useRememberedView();
  const [rememberTicked, setRememberTicked] = useState<boolean | null>(null);
  const remember = rememberChoice(remembered, rememberTicked);

  const unsaved = phase.kind === 'created';
  // Layout effect: the guard holds from the commit that shows the change (BUNNDLY-76).
  useLayoutEffect(() => {
    onUnsavedChange(unsaved);
    return () => {
      onUnsavedChange(false); // unmounted (e.g. after a lock): nothing left to protect
    };
  }, [unsaved, onUnsavedChange]);

  const count = Number(walletCount);
  const countValid =
    walletCount.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= MAX_WALLETS;
  const nameValid = isValidFleetName(fleetName);
  const strength = passwordStrength(password);
  const passwordsMatch = password === password2;
  const words = wordCount(mnemonic);
  const mnemonicValid = !importMnemonic || MNEMONIC_WORD_COUNTS.has(words);
  const canCreate =
    countValid &&
    nameValid &&
    strength.acceptable &&
    passwordsMatch &&
    password2 !== '' &&
    mnemonicValid;

  /** What blocks creation, per field; null when the field is fine. */
  const problems: Record<Field, string | null> = {
    count: countValid ? null : 'The number of wallets must be a whole number from 1 to 100.',
    name: nameValid
      ? null
      : fleetName === ''
        ? 'Enter a fleet name.'
        : ERROR_MESSAGES.INVALID_FLEET_NAME,
    pw: strength.acceptable
      ? null
      : `The password must have at least ${String(MIN_PASSWORD_LENGTH)} characters (now: ${String(strength.length)}).`,
    pw2:
      password2 === ''
        ? 'Repeat the password.'
        : passwordsMatch
          ? null
          : 'The passwords do not match.',
    mn: mnemonicValid
      ? null
      : words === 0
        ? 'Enter the recovery phrase or untick the import.'
        : `The recovery phrase must have 12, 15, 18, 21 or 24 words (now: ${String(words)}).`,
  };
  /** A wrong value shows its message at once; an empty field only after blur or submit. */
  const typed: Record<Field, boolean> = {
    count: true,
    name: fleetName !== '',
    pw: false,
    pw2: password2 !== '',
    mn: mnemonic !== '',
  };
  const shown = (field: Field): string | null =>
    submitted || touched.has(field) || typed[field] ? problems[field] : null;
  const touch = (field: Field): void => {
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)));
  };
  const fieldError = (field: Field) => {
    const message = shown(field);
    return (
      message !== null && (
        <p id={`${ids}-${field}-error`} className="field-error">
          {message}
        </p>
      )
    );
  };
  const describedBy = (field: Field): string | undefined =>
    shown(field) === null ? undefined : `${ids}-${field}-error`;

  const create = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canCreate) {
      setSubmitted(true);
      const first = FIELDS.find((field) => problems[field] !== null);
      if (first !== undefined) document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }
    setTouched(new Set());
    setSubmitted(false);
    const secret = { password, mnemonic: importMnemonic ? mnemonic : undefined };
    // Clear the secrets from the form right away; only the worker keeps them.
    setPassword('');
    setPassword2('');
    setMnemonic('');
    setShowMnemonic(false);
    setError(null);
    setPhase({ kind: 'creating', progress: 0 });
    try {
      const result = await client.request(
        {
          type: 'create',
          fleetName,
          walletCount: count,
          password: secret.password,
          ...(secret.mnemonic === undefined ? {} : { mnemonic: secret.mnemonic }),
          remember,
        },
        {
          onProgress: (progress) => {
            setPhase({ kind: 'creating', progress });
          },
        },
      );
      setPhase({ kind: 'created', fileText: result.fileText, info: result.info, saving: false });
      // The new fleet is unlocked in the worker; show that at once (lock button, header).
      void refresh();
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'form' });
    }
  };

  const save = async (fileText: string, info: VaultInfo): Promise<void> => {
    setError(null);
    setPhase({ kind: 'created', fileText, info, saving: true });
    try {
      const result = await saveKeystoreFile(fileText, info.fleetName, storage, {
        confirmOverwrite,
      });
      setPhase({ kind: 'saved', result, info });
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'created', fileText, info, saving: false });
    }
  };

  const errorBox = error && (
    <p className="notice error" role="alert">
      {error}
    </p>
  );

  if (phase.kind === 'creating') {
    const percent = Math.round(phase.progress * 100);
    return (
      <section className="screen narrow" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Creating the fleet…</h2>
        <p>Encrypting the fleet file. This may take a few seconds.</p>
        <ProgressBar label="Encryption progress" value={percent} max={100} tone="run" />
        <p className="muted">{percent}%</p>
      </section>
    );
  }

  if (phase.kind === 'created') {
    const download = !supportsDirectoryPicker(storage);
    return (
      <section className="screen narrow" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Fleet created</h2>
        <p>
          Wallets: <strong>{phase.info.wallets.length}</strong>, fleet name:{' '}
          <strong>{phase.info.fleetName}</strong>
        </p>
        <p className="notice warning" role="status">
          The fleet file is not saved yet. Without this file you cannot open the fleet again.
        </p>
        {download && (
          <p className="muted">
            Your browser will download the file. Then check the “Downloads” folder.
          </p>
        )}
        {errorBox}
        <div className="actions">
          <Button
            variant="primary"
            disabled={phase.saving}
            onClick={() => void save(phase.fileText, phase.info)}
          >
            {phase.saving ? 'Saving…' : 'Save the fleet file'}
          </Button>
        </div>
      </section>
    );
  }

  if (phase.kind === 'saved') {
    const { result, info } = phase;
    return (
      <section className="screen narrow" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Fleet file saved</h2>
        <ul>
          <li>
            Wallets: <strong>{info.wallets.length}</strong>
          </li>
          <li>
            File: <strong>{result.fileName}</strong>
            {result.method === 'directory' && result.folder !== '' && (
              <> in the folder “{result.folder}”</>
            )}
          </li>
        </ul>
        {result.method === 'download' && (
          <p className="muted">
            The file was downloaded. Check the “Downloads” folder and move it to a safe place.
          </p>
        )}
        <p className="notice warning" role="status">
          Remember the password. Without the password and without the recovery phrase the funds of
          this fleet cannot be recovered. Back up the recovery phrase now and keep it offline.
        </p>
        <div className="actions">
          <Button
            onClick={() => {
              setExportOpen(true);
            }}
          >
            Back up the recovery phrase
          </Button>
          <Button variant="primary" onClick={onDone}>
            Go to the fleet
          </Button>
        </div>
        {exportOpen && (
          <ExportDialog
            storage={storage}
            onClose={() => {
              setExportOpen(false);
            }}
          />
        )}
      </section>
    );
  }

  return (
    <section className="screen narrow" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>New fleet wizard</h2>
      {errorBox}
      <form className="form" onSubmit={(e) => void create(e)} noValidate>
        <label htmlFor={`${ids}-count`}>Number of wallets</label>
        <Input
          id={`${ids}-count`}
          type="number"
          min={1}
          max={MAX_WALLETS}
          step={1}
          value={walletCount}
          onChange={(e) => {
            setWalletCount(e.target.value);
          }}
          aria-invalid={shown('count') !== null}
          aria-describedby={describedBy('count')}
        />
        {fieldError('count')}

        <label htmlFor={`${ids}-name`}>Fleet name</label>
        <Input
          id={`${ids}-name`}
          value={fleetName}
          autoComplete="off"
          onChange={(e) => {
            setFleetName(e.target.value);
          }}
          onBlur={() => {
            touch('name');
          }}
          aria-invalid={shown('name') !== null}
          aria-describedby={describedBy('name')}
        />
        {fieldError('name')}

        <label htmlFor={`${ids}-pw`}>Password</label>
        <Input
          id={`${ids}-pw`}
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => {
            setPassword(e.target.value);
          }}
          onBlur={() => {
            touch('pw');
          }}
          aria-invalid={shown('pw') !== null}
          aria-describedby={describedBy('pw')}
        />
        <ProgressBar
          label="Password strength"
          value={strength.score}
          max={4}
          valueText={strength.label}
          tone={strength.score <= 1 ? 'danger' : strength.score === 2 ? 'warn' : 'ok'}
        />
        <p className="muted" aria-live="polite">
          Password strength: {strength.label}
        </p>
        {fieldError('pw')}
        {shown('pw') === null &&
          strength.hints.map((hint) => (
            <p key={hint} className="hint">
              {hint}
            </p>
          ))}

        <label htmlFor={`${ids}-pw2`}>Repeat the password</label>
        <Input
          id={`${ids}-pw2`}
          type="password"
          value={password2}
          autoComplete="new-password"
          onChange={(e) => {
            setPassword2(e.target.value);
          }}
          onBlur={() => {
            touch('pw2');
          }}
          aria-invalid={shown('pw2') !== null}
          aria-describedby={describedBy('pw2')}
        />
        {fieldError('pw2')}

        <label className="checkbox">
          <Checkbox
            checked={importMnemonic}
            onChange={(checked) => {
              setImportMnemonic(checked);
              if (!checked) setMnemonic('');
            }}
          />
          I already have a recovery phrase (import 12–24 words)
        </label>
        <p className="hint">
          The import is optional: without it the app generates a new recovery phrase (24 words), and
          a phrase from a wallet such as Phantom makes the first wallets of the fleet the same
          accounts as in that wallet (the same path <code>{MNEMONIC_PATH}</code>).
        </p>
        {importMnemonic && (
          <>
            <label htmlFor={`${ids}-mn`}>Recovery phrase</label>
            <div className="inline">
              <Input
                id={`${ids}-mn`}
                type={showMnemonic ? 'text' : 'password'}
                value={mnemonic}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => {
                  setMnemonic(e.target.value);
                }}
                onBlur={() => {
                  touch('mn');
                }}
                aria-invalid={shown('mn') !== null}
                aria-describedby={describedBy('mn')}
              />
              <Button
                onClick={() => {
                  setShowMnemonic((s) => !s);
                }}
              >
                {showMnemonic ? 'Hide' : 'Show'}
              </Button>
            </div>
            {fieldError('mn')}
          </>
        )}

        <RememberOption view={remembered} checked={remember} onChange={setRememberTicked} />

        <div className="actions">
          <Button type="submit" variant="primary">
            Create the fleet
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    </section>
  );
}
