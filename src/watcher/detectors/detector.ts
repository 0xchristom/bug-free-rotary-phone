/**
 * Mint detection for one arming (SPEC 3.4, BUNNDLY-33, D-037): a signature of the watched
 * address in, launch detections out.
 *
 * - Log from the live stream: the fast path names the mint at once, no RPC.
 * - Every signature (live or catch-up) then takes the slow path: `getTransaction`, asked
 *   every 200 ms for up to 15 s (a `processed` transaction is not readable at once). It
 *   finds what the log cannot (LaunchLab, the generic fallback, catch-up) and verifies
 *   the fast path: a mismatch is a warning, not a stop (the buy has already started).
 * - Each mint is detected once per arming, whichever path sees it first.
 */
import type { StreamClock } from '../stream.ts';
import { detectFromLogs } from './log-path.ts';
import type { DetectionSource } from './programs.ts';
import { asTransaction, detectFromTransaction } from './transaction-path.ts';

export type DetectionPath = 'log' | 'transaction' | 'catch-up';

export interface Detection {
  readonly mint: string;
  readonly source: DetectionSource;
  readonly path: DetectionPath;
  readonly signature: string;
  /** Known from the transaction; null on the fast path. */
  readonly slot: bigint | null;
  /** Block time (Unix s) from the transaction; null on the fast path (a live log is new). */
  readonly blockTime: number | null;
  /** When the signature reached the worker (`performance.now()`), for the reaction time. */
  readonly receivedAt: number;
}

export type DetectorEvent =
  | { readonly kind: 'detection'; readonly detection: Detection }
  /** The transaction of a fast-path detection: does it create the same mint? */
  | {
      readonly kind: 'verified';
      readonly mint: string;
      readonly signature: string;
      readonly match: boolean;
    }
  /** No transaction within the time limit: nothing more from this signature. */
  | { readonly kind: 'transaction-unavailable'; readonly signature: string };

/** `getTransaction` (json, confirmed, version 1): the answer, or null when not there yet. */
export type TransactionReader = (signature: string) => Promise<unknown>;

export interface SignatureInput {
  readonly signature: string;
  readonly source: 'logs' | 'catch-up';
  readonly logs: readonly string[] | null;
  readonly receivedAt: number;
}

export const TRANSACTION_POLL_MS = 200;
export const TRANSACTION_TIMEOUT_MS = 15_000;

export interface Detector {
  onSignature(input: SignatureInput): void;
  /** Disarm: no more `getTransaction` and no more events. */
  stop(): void;
  /** Resolves when every slow path started so far has finished. */
  idle(): Promise<void>;
}

export function createDetector(
  deps: {
    readonly getTransaction: TransactionReader;
    readonly clock: StreamClock;
    readonly emit: (event: DetectorEvent) => void;
  },
  options: {
    readonly watched: string;
    readonly pollMs?: number;
    readonly timeoutMs?: number;
  },
): Detector {
  const pollMs = options.pollMs ?? TRANSACTION_POLL_MS;
  const timeoutMs = options.timeoutMs ?? TRANSACTION_TIMEOUT_MS;
  const detected = new Set<string>();
  const pending = new Set<Promise<void>>();
  let stopped = false;
  const isStopped = (): boolean => stopped;

  const detect = (d: Detection): void => {
    if (isStopped() || detected.has(d.mint)) return;
    detected.add(d.mint);
    deps.emit({ kind: 'detection', detection: d });
  };

  const slowPath = async (input: SignatureInput, fastMints: readonly string[]): Promise<void> => {
    const deadline = deps.clock.now() + timeoutMs;
    for (;;) {
      if (isStopped()) return;
      let answer: unknown;
      try {
        answer = await deps.getTransaction(input.signature);
      } catch {
        answer = null; // RPC trouble: ask again
      }
      if (isStopped()) return;
      const tx = answer === null ? null : asTransaction(answer);
      if (tx !== null) {
        const found = detectFromTransaction(tx, options.watched);
        for (const f of found) {
          if (fastMints.includes(f.mint)) continue;
          detect({
            mint: f.mint,
            source: f.source,
            path: input.source === 'catch-up' ? 'catch-up' : 'transaction',
            signature: input.signature,
            slot: BigInt(tx.slot),
            blockTime:
              tx.blockTime === null || tx.blockTime === undefined ? null : Number(tx.blockTime),
            receivedAt: input.receivedAt,
          });
        }
        for (const mint of fastMints) {
          deps.emit({
            kind: 'verified',
            mint,
            signature: input.signature,
            match: found.some((f) => f.mint === mint),
          });
        }
        return;
      }
      if (deps.clock.now() >= deadline) {
        deps.emit({ kind: 'transaction-unavailable', signature: input.signature });
        return;
      }
      await deps.clock.sleep(pollMs);
    }
  };

  return {
    onSignature(input) {
      if (stopped) return;
      const fast = input.logs === null ? [] : detectFromLogs(input.logs, options.watched);
      const fastMints: string[] = [];
      for (const f of fast) {
        if (detected.has(f.mint)) continue;
        fastMints.push(f.mint);
        detect({
          mint: f.mint,
          source: f.source,
          path: 'log',
          signature: input.signature,
          slot: null,
          blockTime: null,
          receivedAt: input.receivedAt,
        });
      }
      const p = slowPath(input, fastMints).finally(() => {
        pending.delete(p);
      });
      pending.add(p);
    },
    stop() {
      stopped = true;
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
