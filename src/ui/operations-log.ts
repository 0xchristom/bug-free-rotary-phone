/**
 * Operations log in the UI (BUNNDLY-25, D-031): keeps every executor event of this
 * session, with the wallet's public address as it was then, outside React state, so the
 * log survives screen changes and the auto-lock after a buy. Memory only: nothing goes to
 * storage (SPEC 6.1); the user downloads it as CSV or JSON.
 */
import { useSyncExternalStore } from 'react';
import { logEntry, type LogEntry } from '../executor/oplog.ts';
import type { ExecutorEvent } from '../executor/executor.ts';
import type { VaultClient } from '../worker/vault-client.ts';

interface Recorded {
  readonly event: ExecutorEvent;
  readonly address: string | null;
}

export interface OperationsLog {
  /** Number of recorded events; changes on every event. */
  readonly size: () => number;
  /** Entries with the token's decimals for the price (null when not known). */
  readonly entries: (decimals: number | null) => LogEntry[];
  /** Run id of the newest event, for the file name. */
  readonly lastRunId: () => number | null;
  readonly subscribe: (listener: () => void) => () => void;
  /** Addresses of the open fleet; events are recorded with the address of their time. */
  readonly setWallets: (wallets: readonly { index: number; address: string }[]) => void;
}

export function createOperationsLog(client: VaultClient): OperationsLog {
  const recorded: Recorded[] = [];
  const listeners = new Set<() => void>();
  let addresses = new Map<number, string>();
  client.onEvent((event) => {
    const address = event.kind === 'run' ? null : (addresses.get(event.index) ?? null);
    recorded.push({ event, address });
    for (const l of listeners) l();
  });
  return {
    setWallets(wallets) {
      addresses = new Map(wallets.map((w) => [w.index, w.address]));
    },
    size: () => recorded.length,
    entries: (decimals) =>
      recorded.map((r) => logEntry(r.event, { addressOf: () => r.address, decimals })),
    lastRunId: () => recorded.at(-1)?.event.runId ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Re-renders on every new event; returns the number of events. */
export function useOperationsLogSize(log: OperationsLog): number {
  return useSyncExternalStore(log.subscribe, log.size);
}
