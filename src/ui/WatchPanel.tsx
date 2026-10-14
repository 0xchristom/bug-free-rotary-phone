import { useEffect, useId, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { BuyMode } from '../core/settings.ts';
import type { WatchDetection } from '../watcher/watch.ts';
import { useVault } from './vault-state.ts';
import {
  PATH_LABELS,
  SOURCE_LABELS,
  connectionLabel,
  connectionTone,
  problemLabel,
} from './watch-labels.ts';
import { useWatchRuntime } from './watch-runtime.ts';
import { Button, Modal } from './kit/index.ts';

export interface WatchPanelProps {
  readonly mode: BuyMode;
  /** Saves the one-shot/continuous setting in the vault. */
  readonly onMode: (mode: BuyMode) => Promise<void>;
}

const MODE_HELP: Readonly<Record<BuyMode, string>> = {
  'one-shot': 'One-shot: the first detected token disarms the watcher, and the buy continues.',
  continuous:
    'Continuous: the watcher stays armed and buys each new token from the creator, one after another.',
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
 * Mode B state (SPEC 3.4, BUNNDLY-35, D-039): the watched creator, one-shot or continuous,
 * the connection and the detections. The creator field and ARM / DISARM are in the command
 * bar (BUNNDLY-59).
 */
export function WatchPanel({ mode, onMode }: WatchPanelProps) {
  const { status } = useVault();
  const { wake } = useWatchRuntime();
  const ids = useId();
  const watch = status?.watch ?? null;
  const armed = watch?.armed ?? false;
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
      {armed && watch && (
        <p>
          Watched creator: <code className="address">{watch.creator}</code>
        </p>
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
        <Modal
          open
          role="alertdialog"
          tone="danger"
          title="Turn on continuous mode?"
          onClose={() => {
            setConfirmContinuous(false);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmContinuous(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  chooseMode('continuous');
                }}
              >
                Yes, continuous mode
              </Button>
            </>
          }
        >
          <p>
            The watcher will not disarm after the first token: each new token from the creator
            starts another buy by the whole fleet.
          </p>
        </Modal>
      )}

      {watch && (
        <p className={`connection ${connectionTone(watch.connection)}`} role="status">
          Connection: <strong>{connectionLabel(watch.connection, watch.attempt)}</strong>
          {secondsAgo !== null && ` · last message ${String(secondsAgo)} s ago`}
          {!armed && ' · watcher disarmed'}
        </p>
      )}

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
                    <Button aria-label={`Copy mint ${d.mint}`} onClick={() => void copy(d.mint)}>
                      {copied === d.mint ? 'Copied' : 'Copy'}
                    </Button>
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
