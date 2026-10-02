/**
 * Buy progress in the UI (SPEC 3.6, BUNNDLY-27, D-032). Executor events from the worker
 * are buffered and applied once per animation frame; a row object changes only when its
 * wallet got an event, so memoized table rows of other wallets do not re-render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExecutorEvent, RunPhase, WalletQuote, WalletResult } from '../executor/executor.ts';
import type { WalletReason, WalletState } from '../executor/states.ts';
import type { VerifyStatus } from '../executor/verify.ts';
import type { VaultClient } from '../worker/vault-client.ts';

export interface BuyRow {
  readonly state: WalletState;
  readonly attempt: number;
  readonly reason: WalletReason | null;
  readonly quote: WalletQuote | null;
  readonly result: WalletResult | null;
  readonly sinceStartMs: number;
  /** Token balance check after CONFIRMED (live mode). */
  readonly verify: VerifyStatus | null;
}

export interface BuyRun {
  readonly runId: number;
  readonly mint: string;
  readonly dryRun: boolean;
  readonly wallets: number;
  readonly phase: RunPhase;
  /** Since the start, of the first and the last CONFIRMED. */
  readonly firstConfirmMs: number | null;
  readonly lastConfirmMs: number | null;
}

export interface BuyCounts {
  readonly confirmed: number;
  readonly inProgress: number;
  readonly failedOrSkipped: number;
}

export interface BuyView {
  readonly run: BuyRun | null;
  readonly rows: ReadonlyMap<number, BuyRow>;
  readonly counts: BuyCounts;
}

export const EMPTY_BUY: BuyView = {
  run: null,
  rows: new Map(),
  counts: { confirmed: 0, inProgress: 0, failedOrSkipped: 0 },
};

/** Still working on it: in the pipeline, or UNKNOWN while the chain is checked. */
export function inProgress(row: BuyRow): boolean {
  if (row.state === 'UNKNOWN') return row.reason?.code === 'EXECUTE_NO_ANSWER';
  return ['IDLE', 'QUEUED', 'QUOTING', 'SIGNING', 'SUBMITTED'].includes(row.state);
}

function count(rows: ReadonlyMap<number, BuyRow>): BuyCounts {
  let confirmed = 0;
  let working = 0;
  let other = 0;
  for (const row of rows.values()) {
    if (row.state === 'CONFIRMED') confirmed += 1;
    else if (inProgress(row)) working += 1;
    else other += 1;
  }
  return { confirmed, inProgress: working, failedOrSkipped: other };
}

/** Applies a batch of events. Pure; events of an older run are ignored. */
export function reduceBuy(view: BuyView, events: readonly ExecutorEvent[]): BuyView {
  let { run } = view;
  let rows = view.rows;
  let copied = false;
  const edit = (): Map<number, BuyRow> => {
    if (!copied) {
      rows = new Map(rows);
      copied = true;
    }
    return rows as Map<number, BuyRow>;
  };
  for (const event of events) {
    if (event.kind === 'run') {
      if (event.phase === 'started' && (run === null || event.runId > run.runId)) {
        run = {
          runId: event.runId,
          mint: event.mint,
          dryRun: event.dryRun,
          wallets: event.wallets,
          phase: 'started',
          firstConfirmMs: null,
          lastConfirmMs: null,
        };
        rows = new Map();
        copied = true;
      } else if (run !== null && event.runId === run.runId) {
        run = { ...run, phase: event.phase };
      }
      continue;
    }
    if (run === null || event.runId !== run.runId) continue;
    if (event.kind === 'verify') {
      const row = rows.get(event.index);
      if (row) edit().set(event.index, { ...row, verify: event.status });
      continue;
    }
    const before = rows.get(event.index);
    edit().set(event.index, {
      state: event.state,
      attempt: event.attempt,
      reason: event.reason,
      quote: event.quote,
      result: event.result,
      sinceStartMs: event.times.sinceStartMs,
      verify: before?.verify ?? null,
    });
    if (event.state === 'CONFIRMED') {
      const ms = event.times.sinceStartMs;
      run = {
        ...run,
        firstConfirmMs: run.firstConfirmMs === null ? ms : Math.min(run.firstConfirmMs, ms),
        lastConfirmMs: run.lastConfirmMs === null ? ms : Math.max(run.lastConfirmMs, ms),
      };
    }
  }
  if (run === view.run && rows === view.rows) return view;
  return { run, rows, counts: rows === view.rows ? view.counts : count(rows) };
}

export type FrameScheduler = (callback: () => void) => void;

const nextFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 16);
};

/** Live buy view from the worker's events, batched once per frame. */
export function useBuyView(client: VaultClient, schedule: FrameScheduler = nextFrame): BuyView {
  const [view, setView] = useState<BuyView>(EMPTY_BUY);
  const buffer = useRef<ExecutorEvent[]>([]);
  const scheduled = useRef(false);
  const alive = useRef(true);

  const flush = useCallback(() => {
    scheduled.current = false;
    if (!alive.current) return;
    const batch = buffer.current.splice(0);
    if (batch.length > 0) setView((v) => reduceBuy(v, batch));
  }, []);

  useEffect(() => {
    alive.current = true;
    const off = client.onEvent((event) => {
      buffer.current.push(event);
      if (!scheduled.current) {
        scheduled.current = true;
        schedule(flush);
      }
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [client, schedule, flush]);

  return view;
}
