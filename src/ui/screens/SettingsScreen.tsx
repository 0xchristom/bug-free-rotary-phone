import { useEffect, useId, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../../core/errors.ts';
import {
  BUY_MODES,
  EXPLORERS,
  JUPITER_PLANS,
  JUPITER_PLAN_RPM,
  JUPITER_RATE_LIMITS_URL,
  endpointUrlProblem,
  orderRps,
  validateGlobalSettings,
  type BuyMode,
  type Explorer,
  type GlobalSettingsV1,
  type JupiterPlan,
  type SettingsField,
} from '../../core/settings.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { ApiKeyChanges, ApiKeyFlags, VaultInfo } from '../../worker/protocol.ts';
import { formatSol, parseSol } from '../sol.ts';
import { SettingsResetNotice } from '../SettingsResetNotice.tsx';
import { useVault } from '../vault-state.ts';

type KeyName = keyof ApiKeyFlags;

const PLAN_LABELS: Record<JupiterPlan, string> = {
  keyless: 'Bez klucza (Keyless)',
  free: 'Free',
  developer: 'Developer',
  launch: 'Launch',
  pro: 'Pro',
  custom: 'Własny',
};

const EXPLORER_LABELS: Record<Explorer, string> = {
  solscan: 'Solscan',
  orb: 'Orb',
  'solana-explorer': 'Solana Explorer',
};

const MODE_LABELS: Record<BuyMode, string> = {
  'one-shot': 'Jednorazowy (po pierwszym tokenie watcher się rozbraja)',
  continuous: 'Ciągły (watcher kupuje każdy kolejny wykryty token)',
};

const KEY_FIELDS: readonly { name: KeyName; label: string; placeholder: string }[] = [
  { name: 'helius', label: 'Klucz API Helius', placeholder: 'Wpisz nowy klucz, aby go zmienić' },
  {
    name: 'heliusRpcUrl',
    label: 'Własny URL RPC (HTTPS, opcjonalnie)',
    placeholder: 'https://….helius-rpc.com/?api-key=… (traktowany jak klucz)',
  },
  {
    name: 'heliusWsUrl',
    label: 'Własny URL WebSocket (WSS, opcjonalnie)',
    placeholder: 'wss://….helius-rpc.com/?api-key=… (traktowany jak klucz)',
  },
  { name: 'jupiter', label: 'Klucz API Jupiter', placeholder: 'Wpisz nowy klucz, aby go zmienić' },
];

const CONTINUOUS_WARNING =
  'Tryb ciągły: watcher nie rozbroi się po pierwszym zakupie i będzie kupował każdy kolejny wykryty token, aż go wyłączysz. Włączyć tryb ciągły?';

interface Form {
  minReserve: string;
  maxAttempts: string;
  priceCeiling: string;
  noRouteWindowS: string;
  backoffMin: string;
  backoffMax: string;
  mode: BuyMode;
  explorer: Explorer;
  autoLock: string;
  plan: JupiterPlan;
  customRpm: string;
}

type KeyDraft = { readonly text: string; readonly show: boolean; readonly remove: boolean };

type SavePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved'; readonly fileText: string; readonly writing: boolean }
  | { readonly kind: 'written'; readonly fileName: string };

function formOf(g: GlobalSettingsV1): Form {
  return {
    minReserve: formatSol(g.minReserveLamports),
    maxAttempts: String(g.maxAttempts),
    priceCeiling: String(g.priceCeilingPercent),
    noRouteWindowS: String(g.noRouteWindowMs / 1000),
    backoffMin: String(g.noRouteBackoffMinMs),
    backoffMax: String(g.noRouteBackoffMaxMs),
    mode: g.mode,
    explorer: g.explorer,
    autoLock: String(g.autoLockMinutes),
    plan: g.jupiterPlan,
    customRpm: String(g.orderRpm),
  };
}

/** Whole number from a text field, NaN otherwise (validation then reports the range). */
function int(text: string): number {
  return /^\d{1,9}$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

function settingsOf(f: Form): GlobalSettingsV1 {
  const windowS = /^\d{1,4}([.,]\d)?$/u.test(f.noRouteWindowS.trim())
    ? Math.round(Number(f.noRouteWindowS.trim().replace(',', '.')) * 1000)
    : Number.NaN;
  return {
    // -1n is out of range on purpose: invalid text gets the range message
    minReserveLamports: parseSol(f.minReserve) ?? -1n,
    maxAttempts: int(f.maxAttempts),
    priceCeilingPercent: int(f.priceCeiling),
    noRouteWindowMs: windowS,
    noRouteBackoffMinMs: int(f.backoffMin),
    noRouteBackoffMaxMs: int(f.backoffMax),
    mode: f.mode,
    explorer: f.explorer,
    autoLockMinutes: int(f.autoLock),
    jupiterPlan: f.plan,
    orderRpm: f.plan === 'custom' ? int(f.customRpm) : JUPITER_PLAN_RPM[f.plan],
  };
}

const EMPTY_DRAFT: KeyDraft = { text: '', show: false, remove: false };
const EMPTY_DRAFTS: Record<KeyName, KeyDraft> = {
  helius: EMPTY_DRAFT,
  jupiter: EMPTY_DRAFT,
  heliusRpcUrl: EMPTY_DRAFT,
  heliusWsUrl: EMPTY_DRAFT,
};

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `Plik „${fileName}” już istnieje w wybranym folderze. Zastąpić go zaktualizowanym plikiem floty?`,
  );
}

export interface SettingsScreenProps {
  readonly info: VaultInfo;
  readonly storage: StorageEnv;
  /** True while saved settings are not written to the file yet. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
}

/**
 * Settings (SPEC 3.3), saved encrypted in the keystore through the vault worker. API keys
 * are write-only (D-016): the screen only knows whether a key is set; an empty field
 * means "no change" and removal is a separate button. Ranges are checked with the same
 * rules as in the worker (core/settings.ts).
 */
export function SettingsScreen({ info, storage, onUnsavedChange }: SettingsScreenProps) {
  const { client, refresh } = useVault();
  const ids = useId();
  const [form, setForm] = useState<Form>(() => formOf(info.settings.global));
  const [drafts, setDrafts] = useState<Record<KeyName, KeyDraft>>(EMPTY_DRAFTS);
  const [phase, setPhase] = useState<SavePhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const unsaved = phase.kind === 'unsaved';
  useEffect(() => {
    onUnsavedChange(unsaved);
    return () => {
      onUnsavedChange(false);
    };
  }, [unsaved, onUnsavedChange]);

  const candidate = settingsOf(form);
  const fieldErrors = new Map<SettingsField, string>(
    validateGlobalSettings(candidate).map((p) => [p.field, p.message]),
  );
  // Custom Helius URLs: checked here with the same rule as in the worker (CSP, D-020).
  const urlErrors = new Map<KeyName, string>();
  for (const [name, protocol] of [
    ['heliusRpcUrl', 'https:'],
    ['heliusWsUrl', 'wss:'],
  ] as const) {
    const text = drafts[name].text.trim();
    const problem = text === '' ? null : endpointUrlProblem(text, protocol);
    if (problem !== null) urlErrors.set(name, problem);
  }
  const invalid = fieldErrors.size > 0 || urlErrors.size > 0;

  const set = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
    if (phase.kind === 'written') setPhase({ kind: 'idle' });
  };
  const setDraft = (name: KeyName, patch: Partial<KeyDraft>): void => {
    setDrafts((d) => ({ ...d, [name]: { ...d[name], ...patch } }));
  };

  const save = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (invalid || phase.kind === 'saving' || phase.kind === 'unsaved') return;
    const apiKeys: { -readonly [K in KeyName]?: string | null } = {};
    for (const { name } of KEY_FIELDS) {
      const d = drafts[name];
      if (d.remove) apiKeys[name] = null;
      else if (d.text.trim() !== '') apiKeys[name] = d.text.trim();
    }
    // Typed keys leave the form right away; only the worker keeps them.
    setDrafts(EMPTY_DRAFTS);
    setError(null);
    setPhase({ kind: 'saving' });
    try {
      const result = await client.request({
        type: 'saveSettings',
        settings: {
          maxSpend: info.settings.maxSpend,
          active: info.settings.active,
          global: candidate,
        },
        apiKeys: apiKeys satisfies ApiKeyChanges,
      });
      setPhase({ kind: 'unsaved', fileText: result.fileText, writing: false });
      await refresh();
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'idle' });
    }
  };

  const writeFile = async (fileText: string): Promise<void> => {
    setError(null);
    setPhase({ kind: 'unsaved', fileText, writing: true });
    try {
      const result = await saveKeystoreFile(fileText, info.fleetName, storage, {
        confirmOverwrite,
      });
      setPhase({ kind: 'written', fileName: result.fileName });
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'unsaved', fileText, writing: false });
    }
  };

  const fieldError = (field: SettingsField) => {
    const message = fieldErrors.get(field);
    return message ? <p className="field-error">{message}</p> : null;
  };

  const numberField = (
    key: keyof Form,
    field: SettingsField,
    label: string,
    suffix: string,
    inputMode: 'numeric' | 'decimal' = 'numeric',
  ) => (
    <>
      <label htmlFor={`${ids}-${key}`}>{label}</label>
      <div className="inline">
        <input
          id={`${ids}-${key}`}
          type="text"
          inputMode={inputMode}
          value={form[key]}
          aria-invalid={fieldErrors.has(field)}
          onChange={(e) => {
            set(key, e.target.value);
          }}
        />
        <span className="muted">{suffix}</span>
      </div>
      {fieldError(field)}
    </>
  );

  const locked = phase.kind === 'saving' || phase.kind === 'unsaved';

  return (
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Ustawienia</h2>
      <p className="muted">
        Ustawienia i klucze API są zapisywane w zaszyfrowanym pliku floty. Klucze nie są nigdy
        pokazywane: wpisany klucz zastępuje zapisany.
      </p>
      <SettingsResetNotice fields={info.settings.resetFields} />
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {phase.kind === 'unsaved' && (
        <div className="notice warning" role="status">
          <p>
            Ustawienia zapisane w sejfie, ale plik floty nie jest jeszcze zaktualizowany. Bez tego
            po ponownym otwarciu wrócą poprzednie ustawienia.
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
              disabled={phase.writing}
              onClick={() => void writeFile(phase.fileText)}
            >
              {phase.writing ? 'Zapisywanie…' : 'Zapisz zaktualizowany plik floty'}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'written' && (
        <p className="notice" role="status">
          Zapisano plik {phase.fileName} z nowymi ustawieniami.
        </p>
      )}

      <form className="form" onSubmit={(e) => void save(e)} noValidate>
        <fieldset disabled={locked}>
          <legend>Klucze API i połączenia</legend>
          {KEY_FIELDS.map(({ name, label, placeholder }) => {
            const d = drafts[name];
            const isSet = info.apiKeys[name];
            return (
              <div key={name} className="key-field">
                <label htmlFor={`${ids}-key-${name}`}>{label}</label>
                <p className="muted" id={`${ids}-key-${name}-state`}>
                  {d.remove
                    ? 'Zostanie usunięty po zapisaniu ustawień.'
                    : isSet
                      ? 'Ustawiony.'
                      : 'Nie ustawiono.'}
                </p>
                <div className="inline">
                  <input
                    id={`${ids}-key-${name}`}
                    type={d.show ? 'text' : 'password'}
                    value={d.text}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={d.remove}
                    aria-describedby={`${ids}-key-${name}-state`}
                    onChange={(e) => {
                      setDraft(name, { text: e.target.value });
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`${d.show ? 'Ukryj' : 'Pokaż'} wpisywany tekst: ${label}`}
                    disabled={d.remove || d.text === ''}
                    onClick={() => {
                      setDraft(name, { show: !d.show });
                    }}
                  >
                    {d.show ? 'Ukryj' : 'Pokaż'}
                  </button>
                  {isSet && (
                    <button
                      type="button"
                      aria-label={`${d.remove ? 'Nie usuwaj' : 'Usuń'}: ${label}`}
                      onClick={() => {
                        setDraft(name, { remove: !d.remove, text: '', show: false });
                      }}
                    >
                      {d.remove ? 'Cofnij usunięcie' : 'Usuń'}
                    </button>
                  )}
                </div>
                {urlErrors.has(name) && <p className="field-error">{urlErrors.get(name)}</p>}
              </div>
            );
          })}

          <label htmlFor={`${ids}-plan`}>Plan Jupitera</label>
          <select
            id={`${ids}-plan`}
            value={form.plan}
            onChange={(e) => {
              const plan = e.target.value as JupiterPlan;
              set('plan', plan);
              if (plan !== 'custom') set('customRpm', String(JUPITER_PLAN_RPM[plan]));
            }}
          >
            {JUPITER_PLANS.map((plan) => (
              <option key={plan} value={plan}>
                {PLAN_LABELS[plan]}
              </option>
            ))}
          </select>
          {form.plan === 'custom' ? (
            numberField('customRpm', 'orderRpm', 'Limit /order (zapytań na minutę)', '/min')
          ) : (
            <p className="muted">
              Limit /order: {JUPITER_PLAN_RPM[form.plan]}/min (
              {String(orderRps(JUPITER_PLAN_RPM[form.plan])).replace('.', ',')} zapytania na
              sekundę, okno 60 s, wspólny dla całej organizacji).
            </p>
          )}
          {fieldError('jupiterPlan')}
          <p className="hint">
            Limity według dokumentacji Jupitera:{' '}
            <a href={JUPITER_RATE_LIMITS_URL} target="_blank" rel="noreferrer noopener">
              Rate Limits
            </a>
            .
          </p>
        </fieldset>

        <fieldset disabled={locked}>
          <legend>Zakupy</legend>
          {numberField(
            'minReserve',
            'minReserveLamports',
            'Minimalna rezerwa (MIN_RESERVE_SOL)',
            'SOL',
            'decimal',
          )}
          {numberField('maxAttempts', 'maxAttempts', 'Maks. liczba prób na portfel', 'prób')}
          {numberField(
            'priceCeiling',
            'priceCeilingPercent',
            'Sufit ceny (maks. odchylenie od pierwszego zakupu floty)',
            '%',
          )}
          {numberField(
            'noRouteWindowS',
            'noRouteWindowMs',
            'Okno ponawiania „no route”',
            's',
            'decimal',
          )}
          {numberField('backoffMin', 'noRouteBackoffMinMs', 'Odstęp ponowień: początkowy', 'ms')}
          {numberField('backoffMax', 'noRouteBackoffMaxMs', 'Odstęp ponowień: maksymalny', 'ms')}

          <p id={`${ids}-mode`}>Tryb</p>
          <div role="radiogroup" aria-labelledby={`${ids}-mode`}>
            {BUY_MODES.map((mode) => (
              <label key={mode} className="checkbox">
                <input
                  type="radio"
                  name={`${ids}-mode`}
                  value={mode}
                  checked={form.mode === mode}
                  onChange={() => {
                    if (mode === 'continuous' && !window.confirm(CONTINUOUS_WARNING)) return;
                    set('mode', mode);
                  }}
                />
                {MODE_LABELS[mode]}
              </label>
            ))}
          </div>
          {form.mode === 'continuous' && (
            <p className="notice warning">
              Tryb ciągły jest włączony: watcher nie rozbroi się po pierwszym zakupie.
            </p>
          )}
        </fieldset>

        <fieldset disabled={locked}>
          <legend>Aplikacja</legend>
          <label htmlFor={`${ids}-explorer`}>Explorer transakcji</label>
          <select
            id={`${ids}-explorer`}
            value={form.explorer}
            onChange={(e) => {
              set('explorer', e.target.value as Explorer);
            }}
          >
            {EXPLORERS.map((x) => (
              <option key={x} value={x}>
                {EXPLORER_LABELS[x]}
              </option>
            ))}
          </select>
          {numberField(
            'autoLock',
            'autoLockMinutes',
            'Automatyczna blokada po bezczynności',
            'min',
          )}
        </fieldset>

        <div className="actions">
          <button type="submit" className="primary" disabled={invalid || locked}>
            {phase.kind === 'saving' ? 'Zapisywanie…' : 'Zapisz ustawienia'}
          </button>
        </div>
      </form>
    </section>
  );
}
