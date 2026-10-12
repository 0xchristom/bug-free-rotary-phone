import { useEffect, useId, useState, type SyntheticEvent } from 'react';
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
  return window.confirm(`Plik „${fileName}” już istnieje w wybranym folderze. Nadpisać go?`);
}

/**
 * Fleet wizard (SPEC 3.1): wallet count, fleet name, password with a strength meter and
 * an optional imported mnemonic. The fleet is created in the vault worker (scrypt with
 * progress); the encrypted file is saved only when the user clicks "Zapisz plik floty",
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

  const unsaved = phase.kind === 'created';
  useEffect(() => {
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
    count: countValid ? null : 'Liczba portfeli musi być liczbą całkowitą od 1 do 100.',
    name: nameValid
      ? null
      : fleetName === ''
        ? 'Podaj nazwę floty.'
        : ERROR_MESSAGES.INVALID_FLEET_NAME,
    pw: strength.acceptable
      ? null
      : `Hasło musi mieć co najmniej ${String(MIN_PASSWORD_LENGTH)} znaków (teraz: ${String(strength.length)}).`,
    pw2: password2 === '' ? 'Powtórz hasło.' : passwordsMatch ? null : 'Hasła nie są takie same.',
    mn: mnemonicValid
      ? null
      : words === 0
        ? 'Wpisz mnemonik albo odznacz import.'
        : `Mnemonik musi mieć 12, 15, 18, 21 albo 24 słowa (teraz: ${String(words)}).`,
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
      <section className="screen" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Tworzenie floty…</h2>
        <p>Szyfruję plik floty. To może potrwać kilka sekund.</p>
        <progress max={100} value={percent} aria-label="Postęp szyfrowania" />
        <p className="muted">{percent}%</p>
      </section>
    );
  }

  if (phase.kind === 'created') {
    const download = !supportsDirectoryPicker(storage);
    return (
      <section className="screen" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Flota utworzona</h2>
        <p>
          Portfele: <strong>{phase.info.wallets.length}</strong>, nazwa floty:{' '}
          <strong>{phase.info.fleetName}</strong>
        </p>
        <p className="notice warning" role="status">
          Plik floty nie jest jeszcze zapisany. Bez tego pliku nie otworzysz floty ponownie.
        </p>
        {download && (
          <p className="muted">Twoja przeglądarka pobierze plik. Sprawdź potem folder „Pobrane”.</p>
        )}
        {errorBox}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={phase.saving}
            onClick={() => void save(phase.fileText, phase.info)}
          >
            {phase.saving ? 'Zapisywanie…' : 'Zapisz plik floty'}
          </button>
        </div>
      </section>
    );
  }

  if (phase.kind === 'saved') {
    const { result, info } = phase;
    return (
      <section className="screen" aria-labelledby={`${ids}-title`}>
        <h2 id={`${ids}-title`}>Plik floty zapisany</h2>
        <ul>
          <li>
            Portfele: <strong>{info.wallets.length}</strong>
          </li>
          <li>
            Plik: <strong>{result.fileName}</strong>
            {result.method === 'directory' && result.folder !== '' && (
              <> w folderze „{result.folder}”</>
            )}
          </li>
        </ul>
        {result.method === 'download' && (
          <p className="muted">
            Plik został pobrany. Sprawdź folder „Pobrane” i przenieś go w bezpieczne miejsce.
          </p>
        )}
        <p className="notice warning" role="status">
          Zapamiętaj hasło. Bez hasła i bez mnemonika nie da się odzyskać środków z tej floty. Zrób
          teraz kopię zapasową mnemonika i przechowuj ją offline.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setExportOpen(true);
            }}
          >
            Zrób kopię zapasową mnemonika
          </button>
          <button type="button" className="primary" onClick={onDone}>
            Przejdź do floty
          </button>
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
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Kreator nowej floty</h2>
      {errorBox}
      <form className="form" onSubmit={(e) => void create(e)} noValidate>
        <label htmlFor={`${ids}-count`}>Liczba portfeli</label>
        <input
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

        <label htmlFor={`${ids}-name`}>Nazwa floty</label>
        <input
          id={`${ids}-name`}
          type="text"
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

        <label htmlFor={`${ids}-pw`}>Hasło</label>
        <input
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
        <meter
          min={0}
          max={4}
          low={2}
          high={3}
          optimum={4}
          value={strength.score}
          aria-label="Siła hasła"
        />
        <p className="muted" aria-live="polite">
          Siła hasła: {strength.label}
        </p>
        {fieldError('pw')}
        {shown('pw') === null &&
          strength.hints.map((hint) => (
            <p key={hint} className="hint">
              {hint}
            </p>
          ))}

        <label htmlFor={`${ids}-pw2`}>Powtórz hasło</label>
        <input
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
          <input
            type="checkbox"
            checked={importMnemonic}
            onChange={(e) => {
              setImportMnemonic(e.target.checked);
              if (!e.target.checked) setMnemonic('');
            }}
          />
          Mam już mnemonik (import 12–24 słów)
        </label>
        <p className="hint">
          Import jest opcjonalny: bez niego aplikacja sama wygeneruje nowy mnemonik (24 słowa), a
          mnemonik z portfela takiego jak Phantom sprawi, że pierwsze portfele floty będą tymi
          samymi kontami co w tamtym portfelu (ta sama ścieżka <code>{MNEMONIC_PATH}</code>).
        </p>
        {importMnemonic && (
          <>
            <label htmlFor={`${ids}-mn`}>Mnemonik</label>
            <div className="inline">
              <input
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
              <button
                type="button"
                onClick={() => {
                  setShowMnemonic((s) => !s);
                }}
              >
                {showMnemonic ? 'Ukryj' : 'Pokaż'}
              </button>
            </div>
            {fieldError('mn')}
          </>
        )}

        <div className="actions">
          <button type="submit" className="primary">
            Utwórz flotę
          </button>
          <button type="button" onClick={onBack}>
            Wróć
          </button>
        </div>
      </form>
    </section>
  );
}
