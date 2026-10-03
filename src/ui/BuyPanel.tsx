import { useEffect, useId, useState, type ReactNode } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { BuyMode, JupiterPlan } from '../core/settings.ts';
import type { ApiKeyFlags } from '../worker/protocol.ts';
import { PLAN_LABELS } from './plan-labels.ts';
import { formatSol } from './sol.ts';
import type { BuyView } from './use-buy.ts';
import { useVault } from './vault-state.ts';
import { WatchPanel } from './WatchPanel.tsx';
import { WATCH_FROZEN } from './watch-labels.ts';

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
  return ms === null ? '–' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

/**
 * Buy panel (SPEC 3.4, 3.6): mode A (BUNNDLY-27: mint, "Kupuj teraz") and mode B
 * (BUNNDLY-35: creator watch, UZBRÓJ / ROZBRÓJ) share the DRY-RUN / live label, switching
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
        <h3 id={`${ids}-title`}>Zakup</h3>
        <span
          className={`mode-label ${dryRun ? 'dry' : 'live'}`}
          aria-label={dryRun ? 'Tryb: DRY-RUN' : 'Tryb: na żywo'}
        >
          {dryRun ? 'DRY-RUN' : 'NA ŻYWO'}
        </span>
      </div>
      <div className="mode-tabs" role="group" aria-label="Sposób zakupu">
        {(
          [
            ['A', 'Tryb A: mint'],
            ['B', 'Tryb B: obserwacja twórcy'],
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
      <p className="muted">
        {dryRun
          ? 'DRY-RUN: prawdziwe zapytania o cenę i podpisy, ale żadna transakcja nie zostanie wysłana.'
          : 'Tryb na żywo: zakup wysyła prawdziwe transakcje i wydaje SOL z portfeli.'}
      </p>

      {watchArmed && !running && <p className="muted">{WATCH_FROZEN}</p>}
      {!running &&
        !watchArmed &&
        (dryRun ? (
          confirmLive ? (
            <div
              className="notice warning"
              role="alertdialog"
              aria-labelledby={`${ids}-live-title`}
              aria-describedby={`${ids}-live-text`}
            >
              <p id={`${ids}-live-title`}>
                <strong>Przełączyć na tryb na żywo?</strong>
              </p>
              <p id={`${ids}-live-text`}>
                Następny zakup wyda prawdziwe SOL: do {formatSol(toSpend)} SOL z {readyCount}{' '}
                {readyCount === 1 ? 'portfela' : 'portfeli'}. Transakcji na łańcuchu nie da się
                cofnąć.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setMode(false);
                  }}
                >
                  Tak, przełącz na tryb na żywo
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmLive(false);
                  }}
                >
                  Anuluj
                </button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setConfirmLive(true);
                }}
              >
                Przełącz na tryb na żywo…
              </button>
            </div>
          )
        ) : (
          <div className="actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setMode(true);
              }}
            >
              Wróć do DRY-RUN
            </button>
          </div>
        ))}

      <dl className="summary" aria-label="Przed zakupem">
        {tab === 'A' && (
          <div>
            <dt>Token</dt>
            <dd>
              {mint === null ? (
                'podaj mint i kliknij „Pokaż saldo tokenu”'
              ) : (
                <code className="address">{mint}</code>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Gotowe portfele</dt>
          <dd>{readyCount}</dd>
        </div>
        <div>
          <dt>Łącznie do wydania</dt>
          <dd>{formatSol(toSpend)} SOL</dd>
        </div>
        <div>
          <dt>Tryb</dt>
          <dd>{dryRun ? 'DRY-RUN' : 'na żywo'}</dd>
        </div>
        <div>
          <dt>Limity Jupitera</dt>
          <dd>
            {PLAN_LABELS[plan.plan]}, {plan.orderRpm} /order na minutę
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
          <button
            type="button"
            className="stop"
            disabled={stopping || busy !== null}
            onClick={stop}
          >
            {stopping ? 'Zatrzymywanie…' : 'STOP'}
          </button>
        </div>
      ) : (
        tab === 'A' && (
          <div className="actions">
            <button type="button" className="primary buy" disabled={!canStart} onClick={start}>
              {busy === 'start' ? 'Start…' : 'Kupuj teraz'}
            </button>
            {blocked && <span className="muted">{blocked}</span>}
          </div>
        )
      )}
      {running && (
        <p className="notice warning" role="status">
          Zakup trwa. Nie zamykaj ani nie przeładowuj tej karty, dopóki się nie skończy: klucze i
          zakup działają tylko w niej.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {run && (
        <div className="progress-bar" role="status" aria-live="polite">
          <progress max={run.wallets} value={counts.confirmed} aria-label="Potwierdzone zakupy" />
          <p>
            <strong>
              {counts.confirmed}/{run.wallets} potwierdzonych
            </strong>
            {' · '}
            {counts.inProgress} w trakcie{' · '}
            {counts.failedOrSkipped} nieudanych albo pominiętych
            {run.dryRun && ' · DRY-RUN'}
            {run.phase === 'finished' && ' · zakończony'}
          </p>
          <p className="muted">
            {fromDetection ? 'Od wykrycia' : 'Od startu'} do pierwszego potwierdzenia:{' '}
            {seconds(run.firstConfirmMs)}, do ostatniego: {seconds(run.lastConfirmMs)}
          </p>
        </div>
      )}
      {children}
    </section>
  );
}
