import { useEffect, useId, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../../core/errors.ts';
import { EXPLORERS, NETWORK_LABELS, type Explorer, type Network } from '../../core/network.ts';
import {
  BUY_MODES,
  JUPITER_PLANS,
  JUPITER_PLAN_RPM,
  JUPITER_RATE_LIMITS_URL,
  endpointUrlProblem,
  orderRps,
  validateGlobalSettings,
  type BuyMode,
  type GlobalSettingsV1,
  type JupiterPlan,
  type SettingsField,
} from '../../core/settings.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { FleetTradeV1 } from '../../core/trade.ts';
import type { ApiKeyChanges, ApiKeyFlags, VaultInfo } from '../../worker/protocol.ts';
import { formatSol, parseSol } from '../sol.ts';
import { ConnectionTest } from '../ConnectionTest.tsx';
import { SettingsResetNotice } from '../SettingsResetNotice.tsx';
import { PLAN_LABELS } from '../plan-labels.ts';
import { useVault } from '../vault-state.ts';
import {
  DEFAULT,
  amountText,
  parseAmount,
  parseSellPercent,
  parseSlippage,
  slippageText,
} from '../trade-edit.ts';
import { WATCH_FROZEN } from '../watch-labels.ts';
import { Button, Checkbox, Input, NumberInput } from '../kit/index.ts';
import { DeviceSettings } from '../remember-ui.tsx';

type KeyName = keyof ApiKeyFlags;

const EXPLORER_LABELS: Record<Explorer, string> = {
  solscan: 'Solscan',
  orb: 'Orb',
  'solana-explorer': 'Solana Explorer',
};

const MODE_LABELS: Record<BuyMode, string> = {
  'one-shot': 'One-shot (the watcher disarms after the first token)',
  continuous: 'Continuous (the watcher buys each new detected token)',
};

const KEY_FIELDS: readonly { name: KeyName; label: string; placeholder: string }[] = [
  { name: 'helius', label: 'Helius API key', placeholder: 'Type a new key to change it' },
  {
    name: 'heliusRpcUrl',
    label: 'Custom RPC URL (HTTPS, optional)',
    placeholder: 'https://….helius-rpc.com/?api-key=… (treated like a key)',
  },
  {
    name: 'heliusWsUrl',
    label: 'Custom WebSocket URL (WSS, optional)',
    placeholder: 'wss://….helius-rpc.com/?api-key=… (treated like a key)',
  },
  { name: 'jupiter', label: 'Jupiter API key', placeholder: 'Type a new key to change it' },
];

const CONTINUOUS_WARNING =
  'Continuous mode: the watcher will not disarm after the first buy and will buy each new detected token until you turn it off. Turn on continuous mode?';

function liveWarning(network: Network): string {
  return `Network: ${NETWORK_LABELS[network]}. You are turning DRY-RUN off: a buy will send real transactions and spend SOL from the wallets (up to the max spend of each). Turn DRY-RUN off?`;
}

interface Form {
  dryRun: boolean;
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
  /** Fleet trade defaults (D-045): what a wallet without its own value uses. */
  tradeAmount: string;
  tradeUnit: 'SOL' | '%';
  tradeSellPart: string;
  tradeBuySlip: string;
  tradeSellSlip: string;
}

type TradeKey = 'tradeAmount' | 'tradeSellPart' | 'tradeBuySlip' | 'tradeSellSlip';

/** The fleet defaults from the form, or a message per field that is wrong. */
function fleetTradeOf(
  f: Form,
  saved: FleetTradeV1,
): { readonly fleet: FleetTradeV1 | null; readonly errors: Map<TradeKey, string> } {
  const errors = new Map<TradeKey, string>();
  const amount = parseAmount(f.tradeAmount, f.tradeUnit);
  if (!amount.ok) errors.set('tradeAmount', amount.message);
  const sell = f.tradeSellPart.trim() === '' ? null : parseSellPercent(f.tradeSellPart);
  if (sell === null) errors.set('tradeSellPart', 'Enter a whole number from 1 to 100.');
  else if (!sell.ok) errors.set('tradeSellPart', sell.message);
  // For the fleet there is no default above it: an empty slippage field is Auto.
  const buySlip = parseSlippage(f.tradeBuySlip);
  if (!buySlip.ok) errors.set('tradeBuySlip', buySlip.message);
  const sellSlip = parseSlippage(f.tradeSellSlip);
  if (!sellSlip.ok) errors.set('tradeSellSlip', sellSlip.message);
  if (errors.size > 0 || !amount.ok || !sell?.ok || !buySlip.ok || !sellSlip.ok) {
    return { fleet: null, errors };
  }
  return {
    fleet: {
      buyAmount: amount.value === DEFAULT ? null : amount.value,
      sellPercent: sell.value === DEFAULT ? saved.sellPercent : sell.value,
      buySlippageBps: buySlip.value === DEFAULT ? null : buySlip.value,
      sellSlippageBps: sellSlip.value === DEFAULT ? null : sellSlip.value,
      // Not edited here: on the Jupiter route the fee is not sent (D-045).
      buyPriorityFeeLamports: saved.buyPriorityFeeLamports,
      sellPriorityFeeLamports: saved.sellPriorityFeeLamports,
    },
    errors,
  };
}

/** Form fields edited as text. */
type TextKey = {
  [K in keyof Form]: Form[K] extends string ? (string extends Form[K] ? K : never) : never;
}[keyof Form];

type KeyDraft = { readonly text: string; readonly show: boolean; readonly remove: boolean };

type SavePhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved'; readonly fileText: string; readonly writing: boolean }
  | { readonly kind: 'written'; readonly fileName: string };

function formOf(g: GlobalSettingsV1, t: FleetTradeV1): Form {
  return {
    tradeAmount: amountText(t.buyAmount),
    tradeUnit: t.buyAmount?.kind === 'percent' ? '%' : 'SOL',
    tradeSellPart: String(t.sellPercent),
    // Auto is the empty field here: the fleet has no default above it.
    tradeBuySlip: t.buySlippageBps === null ? '' : slippageText(t.buySlippageBps),
    tradeSellSlip: t.sellSlippageBps === null ? '' : slippageText(t.sellSlippageBps),
    dryRun: g.dryRun,
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

function settingsOf(f: Form, network: Network): GlobalSettingsV1 {
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
    dryRun: f.dryRun,
    // Not in the form: the network is changed in the header and kept as the vault has it.
    network,
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
    `The file “${fileName}” already exists in the chosen folder. Replace it with the updated fleet file?`,
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
  const { client, status, refresh } = useVault();
  const watchArmed = status?.watch?.armed ?? false;
  const ids = useId();
  const [form, setForm] = useState<Form>(() =>
    formOf(info.settings.global, info.settings.trade.fleet),
  );
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

  const { network } = info.settings.global;
  const candidate = settingsOf(form, network);
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
  const tradeForm = fleetTradeOf(form, info.settings.trade.fleet);
  const invalid = fieldErrors.size > 0 || urlErrors.size > 0 || tradeForm.fleet === null;

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
    const fleetTrade = tradeForm.fleet;
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
          trade: { fleet: fleetTrade, wallets: info.settings.trade.wallets },
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
    key: TextKey,
    field: SettingsField,
    label: string,
    suffix: string,
    inputMode: 'numeric' | 'decimal' = 'numeric',
  ) => (
    <>
      <label htmlFor={`${ids}-${key}`}>{label}</label>
      {/* The unit sits inside the field; screen readers get it as the description. */}
      <NumberInput
        id={`${ids}-${key}`}
        className="settings-number"
        unit={suffix}
        inputMode={inputMode}
        value={form[key]}
        invalid={fieldErrors.has(field)}
        aria-description={suffix}
        onChange={(e) => {
          set(key, e.target.value);
        }}
      />
      {fieldError(field)}
    </>
  );

  const tradeField = (key: TradeKey, label: string, unit: string, hint: string) => (
    <>
      <label htmlFor={`${ids}-${key}`}>{label}</label>
      <NumberInput
        id={`${ids}-${key}`}
        className="settings-number"
        unit={unit}
        value={form[key]}
        invalid={tradeForm.errors.has(key)}
        aria-description={unit}
        onChange={(e) => {
          set(key, e.target.value);
        }}
      />
      {tradeForm.errors.has(key) ? (
        <p className="field-error">{tradeForm.errors.get(key)}</p>
      ) : (
        <p className="hint">{hint}</p>
      )}
    </>
  );

  const locked = phase.kind === 'saving' || phase.kind === 'unsaved';

  return (
    <section className="screen narrow" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Settings</h2>
      <p className="muted">
        Settings and API keys are saved in the encrypted fleet file. Keys are never shown: a typed
        key replaces the saved one.
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
            The settings are saved in the vault, but the fleet file is not updated yet. Without that
            the previous settings come back when you open the fleet again.
          </p>
          {!supportsDirectoryPicker(storage) && (
            <p className="muted">
              Your browser will download the file. Then check the “Downloads” folder.
            </p>
          )}
          <div className="actions">
            <Button
              variant="primary"
              disabled={phase.writing}
              onClick={() => void writeFile(phase.fileText)}
            >
              {phase.writing ? 'Saving…' : 'Save the updated fleet file'}
            </Button>
          </div>
        </div>
      )}
      {phase.kind === 'written' && (
        <p className="notice" role="status">
          Saved {phase.fileName} with the new settings.
        </p>
      )}

      <form className="form" onSubmit={(e) => void save(e)} noValidate>
        <fieldset disabled={locked}>
          <legend>API keys and connections</legend>
          {KEY_FIELDS.map(({ name, label, placeholder }) => {
            const d = drafts[name];
            const isSet = info.apiKeys[name];
            return (
              <div key={name} className="key-field">
                <label htmlFor={`${ids}-key-${name}`}>{label}</label>
                <p className="muted" id={`${ids}-key-${name}-state`}>
                  {d.remove
                    ? 'Will be removed when the settings are saved.'
                    : isSet
                      ? 'Set.'
                      : 'Not set.'}
                </p>
                <div className="inline">
                  <Input
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
                  <Button
                    aria-label={`${d.show ? 'Hide' : 'Show'} the typed text: ${label}`}
                    disabled={d.remove || d.text === ''}
                    onClick={() => {
                      setDraft(name, { show: !d.show });
                    }}
                  >
                    {d.show ? 'Hide' : 'Show'}
                  </Button>
                  {isSet && (
                    <Button
                      aria-label={`${d.remove ? 'Keep' : 'Remove'}: ${label}`}
                      onClick={() => {
                        setDraft(name, { remove: !d.remove, text: '', show: false });
                      }}
                    >
                      {d.remove ? 'Undo removal' : 'Remove'}
                    </Button>
                  )}
                </div>
                {urlErrors.has(name) && <p className="field-error">{urlErrors.get(name)}</p>}
              </div>
            );
          })}

          <label htmlFor={`${ids}-plan`}>Jupiter plan</label>
          <select
            className="k-input"
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
            numberField('customRpm', 'orderRpm', '/order limit (requests per minute)', '/min')
          ) : (
            <p className="muted">
              /order limit: {JUPITER_PLAN_RPM[form.plan]}/min (
              {String(orderRps(JUPITER_PLAN_RPM[form.plan]))}/s, 60 s window, shared by the whole
              organization).
            </p>
          )}
          {fieldError('jupiterPlan')}
          <p className="hint">
            Limits per the Jupiter documentation:{' '}
            <a href={JUPITER_RATE_LIMITS_URL} target="_blank" rel="noreferrer noopener">
              Rate Limits
            </a>
            .
          </p>
        </fieldset>

        <fieldset disabled={locked}>
          <legend>Buys</legend>
          {numberField(
            'minReserve',
            'minReserveLamports',
            'Minimum reserve (MIN_RESERVE_SOL)',
            'SOL',
            'decimal',
          )}
          {numberField('maxAttempts', 'maxAttempts', 'Max attempts per wallet', 'attempts')}
          {numberField(
            'priceCeiling',
            'priceCeilingPercent',
            "Price ceiling (max deviation from the fleet's first buy)",
            '%',
          )}
          {numberField(
            'noRouteWindowS',
            'noRouteWindowMs',
            '“No route” retry window',
            's',
            'decimal',
          )}
          {numberField('backoffMin', 'noRouteBackoffMinMs', 'Retry delay: first', 'ms')}
          {numberField('backoffMax', 'noRouteBackoffMaxMs', 'Retry delay: longest', 'ms')}

          <p id={`${ids}-mode`}>Mode</p>
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
              Continuous mode is on: the watcher will not disarm after the first buy.
            </p>
          )}
          <label className="checkbox">
            <Checkbox
              checked={form.dryRun}
              onChange={(checked) => {
                if (!checked && !window.confirm(liveWarning(network))) return;
                set('dryRun', checked);
              }}
            />
            DRY-RUN: buy without sending transactions (real price requests, no SOL spent)
          </label>
          {!form.dryRun && (
            <p className="notice warning">DRY-RUN is off: a buy will send real transactions.</p>
          )}
        </fieldset>

        <fieldset disabled={locked}>
          <legend>Trade defaults</legend>
          <p className="muted">
            A wallet without its own value in the table uses these. A wallet in a running buy, sell
            or armed watch keeps its values until the action ends.
          </p>
          <label htmlFor={`${ids}-tradeAmount`}>Buy amount</label>
          <span className="amount-row">
            <NumberInput
              id={`${ids}-tradeAmount`}
              className="settings-number"
              unit=""
              value={form.tradeAmount}
              placeholder="None"
              invalid={tradeForm.errors.has('tradeAmount')}
              onChange={(e) => {
                set('tradeAmount', e.target.value);
              }}
            />
            <button
              type="button"
              className="unit-toggle"
              aria-label={`Unit of the default buy amount: ${form.tradeUnit === 'SOL' ? 'SOL' : 'percent of balance'}. Switch`}
              onClick={() => {
                set('tradeUnit', form.tradeUnit === 'SOL' ? '%' : 'SOL');
              }}
            >
              {form.tradeUnit}
            </button>
          </span>
          {tradeForm.errors.has('tradeAmount') ? (
            <p className="field-error">{tradeForm.errors.get('tradeAmount')}</p>
          ) : (
            <p className="hint">Empty: a wallet without its own amount does not buy.</p>
          )}
          {tradeField('tradeSellPart', 'Sell part', '%', 'Part of the token balance a sell sells.')}
          {tradeField('tradeBuySlip', 'Buy slippage', '%', 'Empty or “Auto”: Jupiter picks it.')}
          {tradeField('tradeSellSlip', 'Sell slippage', '%', 'Empty or “Auto”: Jupiter picks it.')}
          <label htmlFor={`${ids}-tradeFee`}>Priority fee</label>
          <NumberInput
            id={`${ids}-tradeFee`}
            className="settings-number"
            unit="SOL"
            value=""
            placeholder="Auto"
            aria-description="SOL"
            disabled
          />
          <p className="hint">Auto: on the Jupiter route the priority fee is not sent (D-045).</p>
        </fieldset>

        <fieldset disabled={locked}>
          <legend>Application</legend>
          <label htmlFor={`${ids}-explorer`}>Transaction explorer</label>
          <select
            className="k-input"
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
          {numberField('autoLock', 'autoLockMinutes', 'Auto-lock after inactivity', 'min')}
        </fieldset>

        <div className="actions">
          <Button type="submit" variant="primary" disabled={invalid || locked || watchArmed}>
            {phase.kind === 'saving' ? 'Saving…' : 'Save settings'}
          </Button>
          {watchArmed && <span className="muted">{WATCH_FROZEN}</span>}
        </div>
      </form>

      <ConnectionTest />
      <DeviceSettings />
    </section>
  );
}
