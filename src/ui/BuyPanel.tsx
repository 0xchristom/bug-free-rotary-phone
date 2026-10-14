import { useEffect, useId, useState, type ReactNode } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { DEFAULT_NETWORK, NETWORK_LABELS } from '../core/network.ts';
import type { BuyMode, JupiterPlan } from '../core/settings.ts';
import type { ApiKeyFlags } from '../worker/protocol.ts';
import { DRY_RUN_NOTE, LIVE_NOTE } from './mode-text.ts';
import { PLAN_LABELS } from './plan-labels.ts';
import { formatSol } from './sol.ts';
import type { BuyView } from './use-buy.ts';
import { useVault } from './vault-state.ts';
import { WatchPanel } from './WatchPanel.tsx';
import { WATCH_FROZEN } from './watch-labels.ts';
import { Button, Chip, Modal, ProgressBar } from './kit/index.ts';

export interface BuyPanelProps {
  readonly view: BuyView;
  /** Token address checked by the worker (its balance is on screen), or null. */
  readonly mint: string | null;
  readonly readyCount: number;
  readonly toSpend: bigint;
  readonly dryRun: boolean;
  /** Why a buy cannot start now (e.g. unsaved table), or null. */
  readonly blocked: string | null;
  /** The Jupiter plan whose limits apply (Keyless without a key, D-033). */
  readonly plan: { readonly plan: JupiterPlan; readonly orderRpm: number };
  /** Saves the mode in the vault; the screen then offers to save the fleet file. */
  readonly onDryRun: (dryRun: boolean) => Promise<void>;
  /** Mode B: the fleet's own addresses (a warning if the creator is one of them). */
  readonly fleetAddresses: readonly string[];
  readonly apiKeys: ApiKeyFlags;
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
 * Buy panel (SPEC 3.4, 3.6): mode A (BUNNDLY-27: mint, "Buy now") and mode B
 * (BUNNDLY-35: creator watch, ARM / DISARM) share the DRY-RUN / live label, switching
 * to live only through a confirmation with the amount and wallet count, STOP and the
 * progress bar.
 */
export function BuyPanel({
  view,
  mint,
  readyCount,
  toSpend,
  dryRun,
  blocked,
  plan,
  onDryRun,
  fleetAddresses,
  apiKeys,
  watchMode,
  onWatchMode,
  children,
}: BuyPanelProps) {
  const { client, status, refresh } = useVault();
  const ids = useId();
  const [tab, setTab] = useState<'A' | 'B'>(() => (status?.watch?.armed ? 'B' : 'A'));
  // An armed watcher buys with the settings confirmed at arming: no mode switch (D-039).
  const watchArmed = status?.watch?.armed ?? false;
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState<'start' | 'stop' | 'mode' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, counts } = view;
  const vaultBuy = status?.buy ?? null;
  // Events are newer than the polled status: a finished run is over even if the last
  // status still shows it.
  const running =
    run === null
      ? vaultBuy !== null
      : run.phase !== 'finished' || (vaultBuy !== null && vaultBuy.runId !== run.runId);
  const stopping = run?.phase === 'stopping' || vaultBuy?.accepting === false;
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

  const act = async (kind: 'start' | 'stop' | 'mode', task: () => Promise<unknown>) => {
    setError(null);
    setBusy(kind);
    try {
      await task();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const start = (): void => {
    if (mint === null) return;
    void act('start', async () => {
      await client.request({ type: 'startBuy', mint });
      await refresh();
    });
  };
  const stop = (): void => {
    void act('stop', async () => {
      await client.request({ type: 'stop' });
      await refresh();
    });
  };
  const setMode = (next: boolean): void => {
    setConfirmLive(false);
    void act('mode', () => onDryRun(next));
  };

  // A buy started by a detection counts its times from the detection (SPEC 3.6).
  const fromDetection =
    run !== null && (status?.watch?.detections.some((d) => d.runId === run.runId) ?? false);
  const canStart = !running && busy === null && mint !== null && readyCount > 0 && blocked === null;

  return (
    <section className="buy-panel" aria-labelledby={`${ids}-title`}>
      <div className="buy-head">
        <h3 id={`${ids}-title`}>Buy</h3>
        <Chip tone={dryRun ? 'sim' : 'danger'} aria-label={dryRun ? 'Mode: DRY-RUN' : 'Mode: live'}>
          {dryRun ? 'DRY-RUN' : 'LIVE'}
        </Chip>
      </div>
      <div className="k-seg mode-tabs" role="group" aria-label="Buy mode">
        {(
          [
            ['A', 'Mode A: mint'],
            ['B', 'Mode B: watch a creator'],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => {
              setTab(t);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted">{dryRun ? DRY_RUN_NOTE : LIVE_NOTE}</p>

      {watchArmed && !running && <p className="muted">{WATCH_FROZEN}</p>}
      {!running &&
        !watchArmed &&
        (dryRun ? (
          <div className="actions">
            <Button
              disabled={busy !== null}
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
              disabled={busy !== null}
              onClick={() => {
                setMode(true);
              }}
            >
              Back to DRY-RUN
            </Button>
          </div>
        ))}

      <dl className="summary" aria-label="Before the buy">
        {tab === 'A' && (
          <div>
            <dt>Token</dt>
            <dd>
              {mint === null ? (
                'enter the mint and click “Show token balance”'
              ) : (
                <code className="address">{mint}</code>
              )}
            </dd>
          </div>
        )}
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

      {tab === 'B' && (
        <WatchPanel
          readyCount={readyCount}
          toSpend={toSpend}
          dryRun={dryRun}
          buyRunning={running}
          blocked={blocked}
          fleetAddresses={fleetAddresses}
          apiKeys={apiKeys}
          mode={watchMode}
          onMode={onWatchMode}
        />
      )}

      {running ? (
        <div className="actions">
          <Button
            variant="warn"
            className="stop"
            disabled={stopping || busy !== null}
            onClick={stop}
          >
            {stopping ? 'Stopping…' : 'STOP'}
          </Button>
        </div>
      ) : (
        tab === 'A' && (
          <div className="actions">
            <Button variant="success" disabled={!canStart} onClick={start}>
              {busy === 'start' ? 'Starting…' : 'Buy now'}
            </Button>
            {blocked && <span className="muted">{blocked}</span>}
          </div>
        )
      )}
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
