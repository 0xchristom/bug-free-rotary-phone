import { useEffect, useId, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { BuyMode } from '../core/settings.ts';
import type { ApiKeyFlags } from '../worker/protocol.ts';
import type { WatchDetection } from '../watcher/watch.ts';
import { formatSol } from './sol.ts';
import { useVault } from './vault-state.ts';
import {
  isCreatorAddress,
  PATH_LABELS,
  SOURCE_LABELS,
  connectionLabel,
  connectionTone,
  problemLabel,
} from './watch-labels.ts';
import { useWatchRuntime } from './watch-runtime.ts';

export interface WatchPanelProps {
  readonly readyCount: number;
  readonly toSpend: bigint;
  readonly dryRun: boolean;
  /** A buy runs (mode A or B): arming waits for it. */
  readonly buyRunning: boolean;
  /** Why buying is blocked now (e.g. unsaved table), or null. */
  readonly blocked: string | null;
  readonly fleetAddresses: readonly string[];
  readonly apiKeys: ApiKeyFlags;
  readonly mode: BuyMode;
  /** Saves the one-shot/continuous setting in the vault. */
  readonly onMode: (mode: BuyMode) => Promise<void>;
}

const MODE_HELP: Readonly<Record<BuyMode, string>> = {
  'one-shot': 'One-shot: the first detected token disarms the watcher, and the buy goes on.',
  continuous:
    'Continuous: the watcher stays armed and buys every next token of the creator, one after another.',
};

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function verifiedLabel(d: WatchDetection): string {
  if (d.verified === true) return 'verified';
  if (d.verified === false) return 'does not match the transaction';
  return '–';
}

/**
 * Mode B controls (SPEC 3.4, BUNNDLY-35, D-039): the creator address, one-shot or
 * continuous, the big ARM / DISARM button (live mode only after a confirmation),
 * the connection state and the detections.
 */
export function WatchPanel({
  readyCount,
  toSpend,
  dryRun,
  buyRunning,
  blocked,
  fleetAddresses,
  apiKeys,
  mode,
  onMode,
}: WatchPanelProps) {
  const { client, status, refresh } = useVault();
  const { alarm, wake } = useWatchRuntime();
  const ids = useId();
  const watch = status?.watch ?? null;
  const armed = watch?.armed ?? false;
  const [creatorText, setCreatorText] = useState('');
  const [confirmArm, setConfirmArm] = useState(false);
  const [confirmContinuous, setConfirmContinuous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // "Last message N s ago" moves while the watcher has a connection to show.
  useEffect(() => {
    if (watch === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [watch]);

  const creator = creatorText.trim();
  const creatorValid = isCreatorAddress(creator);
  const inFleet = creatorValid && fleetAddresses.includes(creator);
  const hasHelius =
    (apiKeys.helius || apiKeys.heliusWsUrl) && (apiKeys.helius || apiKeys.heliusRpcUrl);
  const missing =
    blocked ??
    (!hasHelius
      ? 'The watcher needs a Helius key (Settings).'
      : readyCount === 0
        ? 'No ready wallets: mark wallets as active and set their max spend.'
        : !creatorValid
          ? 'Enter a valid creator address.'
          : buyRunning
            ? 'A buy is running: you can arm the watcher when it ends.'
            : null);

  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const arm = (): void => {
    setConfirmArm(false);
    alarm.prime(); // the click allows the alarm sound later (autoplay policy)
    void act(async () => {
      await client.request({ type: 'arm', creator });
      await refresh();
    });
  };
  const disarm = (): void => {
    void act(async () => {
      await client.request({ type: 'disarm' });
      await refresh();
    });
  };
  const onArmClick = (): void => {
    if (dryRun) arm();
    else setConfirmArm(true);
  };
  const chooseMode = (next: BuyMode): void => {
    setConfirmContinuous(false);
    void act(() => onMode(next));
  };
  const copy = async (mint: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(mint);
    } catch {
      setCopied(null);
      setError('The address could not be copied. Select it and copy it by hand.');
    }
  };

  const detections = watch?.detections ?? [];
  const queued = new Set(watch?.queued ?? []);
  const secondsAgo =
    watch?.lastMessageAt == null
      ? null
      : Math.max(0, Math.round((now - watch.lastMessageAt) / 1000));

  return (
    <div className="watch-panel">
      {armed && watch ? (
        <p>
          Watched creator: <code className="address">{watch.creator}</code>
        </p>
      ) : (
        <div className="field">
          <label htmlFor={`${ids}-creator`}>Creator address</label>
          <input
            id={`${ids}-creator`}
            type="text"
            value={creatorText}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={creator !== '' && !creatorValid}
            aria-describedby={`${ids}-creator-help`}
            onChange={(e) => {
              setCreatorText(e.target.value);
            }}
          />
          {creator !== '' && !creatorValid ? (
            <p className="field-error" id={`${ids}-creator-help`} role="alert">
              This is not a valid wallet address (base58, 32 bytes, not the SOL mint).
            </p>
          ) : (
            <p className="hint" id={`${ids}-creator-help`}>
              The wallet that will create the token. The watcher buys every new token this address
              signs.
            </p>
          )}
          {inFleet && (
            <p className="notice warning" role="status">
              This is a wallet from this fleet. Make sure you want to watch your own wallet.
            </p>
          )}
        </div>
      )}

      <fieldset className="watch-mode" disabled={armed || busy}>
        <legend>After a detection</legend>
        {(['one-shot', 'continuous'] as const).map((m) => (
          <label key={m} className="inline">
            <input
              type="radio"
              name={`${ids}-mode`}
              checked={mode === m}
              onChange={() => {
                if (m === 'continuous') setConfirmContinuous(true);
                else chooseMode(m);
              }}
            />
            {m === 'one-shot' ? 'one-shot' : 'continuous'}
          </label>
        ))}
        <p className="hint">{MODE_HELP[mode]}</p>
      </fieldset>
      {confirmContinuous && (
        <div
          className="notice warning"
          role="alertdialog"
          aria-labelledby={`${ids}-cont-title`}
          aria-describedby={`${ids}-cont-text`}
        >
          <p id={`${ids}-cont-title`}>
            <strong>Turn on continuous mode?</strong>
          </p>
          <p id={`${ids}-cont-text`}>
            The watcher will not disarm after the first token: every next token of the creator
            starts another buy by the whole fleet.
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                chooseMode('continuous');
              }}
            >
              Yes, continuous mode
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmContinuous(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {watch && (
        <p className={`connection ${connectionTone(watch.connection)}`} role="status">
          Connection: <strong>{connectionLabel(watch.connection, watch.attempt)}</strong>
          {secondsAgo !== null && ` · last message ${String(secondsAgo)} s ago`}
          {!armed && ' · watcher disarmed'}
        </p>
      )}

      {confirmArm && !armed && (
        <div
          className="notice warning"
          role="alertdialog"
          aria-labelledby={`${ids}-arm-title`}
          aria-describedby={`${ids}-arm-text`}
        >
          <p id={`${ids}-arm-title`}>
            <strong>Arm the watcher in live mode?</strong>
          </p>
          <p id={`${ids}-arm-text`}>
            After a token is detected the fleet buys automatically: up to {formatSol(toSpend)} SOL
            from {readyCount} {readyCount === 1 ? 'wallet' : 'wallets'}
            {mode === 'continuous' ? ' for every token' : ''}. On-chain transactions cannot be
            undone.
          </p>
          <div className="actions">
            <button type="button" className="danger" onClick={arm}>
              Yes, arm
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmArm(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        {armed ? (
          <button type="button" className="arm armed" disabled={busy} onClick={disarm}>
            DISARM
          </button>
        ) : (
          <button
            type="button"
            className="arm"
            disabled={busy || confirmArm || missing !== null}
            onClick={onArmClick}
          >
            {busy ? 'Arming…' : 'ARM'}
          </button>
        )}
        {!armed && missing && <span className="muted">{missing}</span>}
      </div>

      {armed && (
        <p className="notice warning" role="status">
          The watcher is armed. Do not close or reload this tab: the watcher and the buy live only
          in it.
          {wake === 'unavailable' &&
            ' The screen may turn off: the browser cannot keep it on, and a sleeping computer will not detect the token.'}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {detections.length > 0 && (
        <div className="table-wrap">
          <table className="detections">
            <caption>Detections</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Mint</th>
                <th scope="col">Source</th>
                <th scope="col">Path</th>
                <th scope="col">Reaction</th>
                <th scope="col">Verification</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {detections.map((d) => (
                <tr key={`${d.mint}-${d.signature}`}>
                  <td>{new Date(d.detectedAt).toLocaleTimeString('en-GB')}</td>
                  <td>
                    <code title={d.mint}>{shortAddress(d.mint)}</code>{' '}
                    <button
                      type="button"
                      aria-label={`Copy mint ${d.mint}`}
                      onClick={() => void copy(d.mint)}
                    >
                      {copied === d.mint ? 'Copied' : 'Copy'}
                    </button>
                  </td>
                  <td>{SOURCE_LABELS[d.source]}</td>
                  <td>{PATH_LABELS[d.path]}</td>
                  <td>{d.reactionMs === null ? '–' : `${String(Math.round(d.reactionMs))} ms`}</td>
                  <td className={d.verified === false ? 'danger' : undefined}>
                    {verifiedLabel(d)}
                  </td>
                  <td>
                    {d.problem !== null
                      ? problemLabel(d.problem)
                      : queued.has(d.mint)
                        ? 'queued'
                        : d.runId !== null
                          ? `buy #${String(d.runId)}`
                          : 'buy starting…'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
