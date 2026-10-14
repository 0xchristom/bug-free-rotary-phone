import { useEffect, useId, useState, type ReactNode } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { DEFAULT_NETWORK, NETWORK_LABELS } from '../core/network.ts';
import type { BuyMode, JupiterPlan } from '../core/settings.ts';
import { DRY_RUN_NOTE, LIVE_NOTE } from './mode-text.ts';
import { PLAN_LABELS } from './plan-labels.ts';
import { formatSol } from './sol.ts';
import { isBuyRunning, type BuyView } from './use-buy.ts';
import { useVault } from './vault-state.ts';
import { WatchPanel } from './WatchPanel.tsx';
import { WATCH_FROZEN } from './watch-labels.ts';
import { Button, Modal, ProgressBar } from './kit/index.ts';

export interface BuyPanelProps {
  readonly view: BuyView;
  readonly readyCount: number;
  readonly toSpend: bigint;
  readonly dryRun: boolean;
  /** The Jupiter plan whose limits apply (Keyless without a key, D-033). */
  readonly plan: { readonly plan: JupiterPlan; readonly orderRpm: number };
  /** Saves the mode in the vault; the screen then offers to save the fleet file. */
  readonly onDryRun: (dryRun: boolean) => Promise<void>;
  /** One-shot or continuous (the `mode` setting) and how to save it. */
  readonly watchMode: BuyMode;
  readonly onWatchMode: (mode: BuyMode) => Promise<void>;
  /** Shown under the progress (the operations log). */
  readonly children?: ReactNode;
}

function seconds(ms: number | null): string {
  return ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Buy state under the command bar (SPEC 3.4, 3.6): the DRY-RUN / live switch (live only
 * through a confirmation with the amount and wallet count), what a buy would use, the
 * watcher's state (mode B) and the progress bar. The commands themselves are in the
 * command bar (BUNNDLY-59).
 */
export function BuyPanel({
  view,
  readyCount,
  toSpend,
  dryRun,
  plan,
  onDryRun,
  watchMode,
  onWatchMode,
  children,
}: BuyPanelProps) {
  const { status, refresh } = useVault();
  const ids = useId();
  // An armed watcher buys with the settings confirmed at arming: no mode switch (D-039).
  const watchArmed = status?.watch?.armed ?? false;
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { run, counts } = view;
  const running = isBuyRunning(view, status?.buy ?? null);
  const finished = run?.phase === 'finished';

  // The vault leaves the armed state when the run ends: show it without waiting for a poll.
  useEffect(() => {
    if (finished) void refresh();
  }, [finished, refresh]);

  // Closing the tab stops the worker mid-buy: ask the browser to confirm.
  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [running]);

  const setMode = (next: boolean): void => {
    setConfirmLive(false);
    setError(null);
    setBusy(true);
    onDryRun(next).then(
      () => {
        setBusy(false);
      },
      (e: unknown) => {
        setError(toUserMessage(e));
        setBusy(false);
      },
    );
  };

  // A buy started by a detection counts its times from the detection (SPEC 3.6).
  const fromDetection =
    run !== null && (status?.watch?.detections.some((d) => d.runId === run.runId) ?? false);

  return (
    <section className="buy-panel" aria-labelledby={`${ids}-title`}>
      <div className="buy-head">
        <h3 id={`${ids}-title`}>Buy</h3>
      </div>
      <p className="muted">{dryRun ? DRY_RUN_NOTE : LIVE_NOTE}</p>

      {watchArmed && !running && <p className="muted">{WATCH_FROZEN}</p>}
      {!running &&
        !watchArmed &&
        (dryRun ? (
          <div className="actions">
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmLive(true);
              }}
            >
              Switch to live mode…
            </Button>
            {/* The opener stays mounted: the dialog gives the focus back to it. */}
            {confirmLive && (
              <Modal
                open
                role="alertdialog"
                tone="danger"
                title="Switch to live mode?"
                onClose={() => {
                  setConfirmLive(false);
                }}
                footer={
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setConfirmLive(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setMode(false);
                      }}
                    >
                      Yes, switch to live mode
                    </Button>
                  </>
                }
              >
                <p>
                  Network: {NETWORK_LABELS[status?.network ?? DEFAULT_NETWORK]}. The next buy will
                  spend real SOL: up to {formatSol(toSpend)} SOL from {readyCount}{' '}
                  {readyCount === 1 ? 'wallet' : 'wallets'}. On-chain transactions cannot be undone.
                </p>
              </Modal>
            )}
          </div>
        ) : (
          <div className="actions">
            <Button
              disabled={busy}
              onClick={() => {
                setMode(true);
              }}
            >
              Back to DRY-RUN
            </Button>
          </div>
        ))}

      <dl className="summary" aria-label="Before the buy">
        <div>
          <dt>Ready wallets</dt>
          <dd>{readyCount}</dd>
        </div>
        <div>
          <dt>Total to spend</dt>
          <dd>{formatSol(toSpend)} SOL</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{dryRun ? 'DRY-RUN' : 'live'}</dd>
        </div>
        <div>
          <dt>Jupiter limits</dt>
          <dd>
            {PLAN_LABELS[plan.plan]}, {plan.orderRpm} /order per minute
          </dd>
        </div>
      </dl>

      <WatchPanel mode={watchMode} onMode={onWatchMode} />

      {running && (
        <p className="notice warning" role="status">
          A buy is running. Do not close or reload this tab until it ends: the keys and the buy live
          only in it.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {run && (
        <div className="progress-bar" role="status" aria-live="polite">
          <ProgressBar
            label="Confirmed buys"
            value={counts.confirmed}
            max={run.wallets}
            tone={run.phase === 'finished' ? 'ok' : 'run'}
          />
          <p>
            <strong>
              {counts.confirmed}/{run.wallets} confirmed
            </strong>
            {' · '}
            {counts.inProgress} in progress{' · '}
            {counts.failedOrSkipped} failed or skipped
            {run.dryRun && ' · DRY-RUN'}
            {run.phase === 'finished' && ' · finished'}
          </p>
          <p className="muted">
            {fromDetection ? 'From detection' : 'From start'} to the first confirmation:{' '}
            {seconds(run.firstConfirmMs)}, to the last: {seconds(run.lastConfirmMs)}
          </p>
        </div>
      )}
      {children}
    </section>
  );
}
