/**
 * Mode B for one arming (SPEC 1.3, 3.4, BUNNDLY-34, D-038): the creator's log stream, the
 * detectors and the buys they start. Pure logic with injected dependencies; the vault
 * worker supplies the socket, the RPC readers, the clock and `startBuy`.
 *
 * - A detection starts a buy at once (no network wait between the log and the first
 *   `/order`); a detection that comes while a buy runs waits in a FIFO queue, one entry
 *   per mint, and starts when that buy ends.
 * - `one-shot`: the first detection disarms (the socket closes), its buy goes on.
 *   `continuous`: the watcher stays armed.
 * - `disarm` closes the socket and empties the queue; a running buy is not touched.
 * - A detection from a transaction older than arming − 60 s is logged as `stale` and
 *   never bought (second layer after the catch-up time bound, D-036).
 * - `reactionMs`: from the log's receive time in the worker to the first `/order` of the
 *   buy it started. The detection event goes out at that moment, with the time in it.
 */
import type { ErrorCode } from '../core/errors.ts';
import { isAppError } from '../core/errors.ts';
import type { BuyMode } from '../core/settings.ts';
import type { WebSocketFactory } from '../chain/connection-test.ts';
import {
  createDetector,
  type Detection,
  type DetectionPath,
  type Detector,
  type TransactionReader,
} from './detectors/detector.ts';
import type { DetectionSource } from './detectors/programs.ts';
import {
  CATCH_UP_MAX_AGE_MS,
  assertUnixMsClock,
  startStream,
  type SignatureReader,
  type Stream,
  type StreamClock,
  type StreamStatus,
} from './stream.ts';

/** Wallet balances are read again this often while armed (none on the detection path). */
export const BALANCE_REFRESH_MS = 30_000;

/**
 * Why a detection bought nothing. `STALE`: its transaction is from before arming (block
 * time more than 60 s earlier), so the token is not new (second layer after the catch-up
 * time bound, review of PR #26).
 */
export type DetectionProblem = ErrorCode | 'DISARMED' | 'STALE';

export interface WatchDetection {
  readonly mint: string;
  readonly source: DetectionSource;
  readonly path: DetectionPath;
  readonly signature: string;
  /** Unix ms (watch clock). */
  readonly detectedAt: number;
  /** The buy it started; null while queued or when none started. */
  readonly runId: number | null;
  /** Log received → first `/order`; null until then, or when no `/order` was sent. */
  readonly reactionMs: number | null;
  /** Fast-path detection checked against its transaction; null when not checked (yet). */
  readonly verified: boolean | null;
  readonly problem: DetectionProblem | null;
}

interface WatchEventBase {
  readonly kind: 'watch';
  /** Unix ms (watch clock). */
  readonly at: number;
}

export type WatchEvent = WatchEventBase &
  (
    | { readonly type: 'armed'; readonly creator: string; readonly mode: BuyMode }
    | { readonly type: 'disarmed'; readonly reason: 'user' | 'one-shot' }
    | {
        readonly type: 'connection';
        readonly status: StreamStatus;
        readonly attempt: number;
        readonly lastMessageAt: number | null;
      }
    /** Detected while a buy runs: waits for it. */
    | { readonly type: 'queued'; readonly detection: WatchDetection }
    /** From a transaction before arming: logged, never bought. */
    | { readonly type: 'stale'; readonly detection: WatchDetection }
    /** A buy sent its first `/order` (with `reactionMs`), or the detection bought nothing. */
    | { readonly type: 'detection'; readonly detection: WatchDetection }
    | {
        readonly type: 'verified';
        readonly mint: string;
        readonly signature: string;
        readonly match: boolean;
      }
  );

export interface WatchStatus {
  readonly creator: string;
  /** ISO 8601. */
  readonly armedAt: string;
  readonly mode: BuyMode;
  /** Socket open and detecting; false after a one-shot detection or `disarm`. */
  readonly armed: boolean;
  readonly connection: StreamStatus;
  readonly attempt: number;
  readonly lastMessageAt: number | null;
  readonly detections: readonly WatchDetection[];
  /** Mints waiting for the running buy to end. */
  readonly queued: readonly string[];
}

export interface BuyTrigger {
  readonly mint: string;
  /** Unix ms of the detection: the progress view counts from it (SPEC 3.6). */
  readonly detectedAt: number;
  /** Called once, when the buy calls `/order` for the first time. */
  readonly onFirstOrder: () => void;
}

export interface WatchDeps {
  readonly createWebSocket: WebSocketFactory;
  readonly signatures: SignatureReader;
  readonly getTransaction: TransactionReader;
  readonly clock: StreamClock;
  /** High-resolution time (`performance.now()` in the worker), for `reactionMs`. */
  readonly perfNow: () => number;
  readonly random: () => number;
  /** Fleet balances every 30 s (the vault reads them once before arming); failures are ignored. */
  readonly refreshBalances: () => Promise<unknown>;
  /** Some buy (mode A or B) is running. */
  readonly isBuying: () => boolean;
  /** Starts a buy now and returns its run id; throws an AppError when it cannot. */
  readonly startBuy: (trigger: BuyTrigger) => number;
  readonly emit: (event: WatchEvent) => void;
}

export interface WatchOptions {
  /** Helius WebSocket URL with the key; only the stream sees it. */
  readonly url: string;
  readonly creator: string;
  readonly mode: BuyMode;
  readonly balanceRefreshMs?: number;
}

export interface Watch {
  /** Disarms by hand: closes the socket and empties the queue. */
  disarm(): void;
  /** The vault calls this when any buy ends: the next queued detection starts. */
  buyFinished(): void;
  /** Armed, or detections still waiting to buy. Keeps the vault from locking. */
  active(): boolean;
  status(): WatchStatus;
}

interface Entry {
  detection: WatchDetection;
  readonly receivedAt: number;
}

export function startWatch(deps: WatchDeps, options: WatchOptions): Watch {
  const { clock } = deps;
  assertUnixMsClock(clock);
  const armedAt = clock.now();
  let armed = true;
  let connection: { status: StreamStatus; attempt: number; lastMessageAt: number | null } = {
    status: 'connecting',
    attempt: 0,
    lastMessageAt: null,
  };
  const entries: Entry[] = [];
  const queue: Entry[] = [];
  const isArmed = (): boolean => armed;

  const emit = (event: WatchEvent): void => {
    deps.emit(event);
  };
  const update = (entry: Entry, change: Partial<WatchDetection>): void => {
    entry.detection = { ...entry.detection, ...change };
  };
  const announce = (entry: Entry): void => {
    emit({ kind: 'watch', at: clock.now(), type: 'detection', detection: entry.detection });
  };

  /** The detection whose buy has not sent `/order` yet. */
  let running: Entry | null = null;

  const begin = (entry: Entry): void => {
    let runId: number | null = null;
    let firstOrderAt: number | null = null;
    // Read through a function: `onFirstOrder` may set it inside `startBuy`.
    const ordered = (): boolean => firstOrderAt !== null;
    const send = (): void => {
      update(entry, {
        runId,
        reactionMs: firstOrderAt === null ? null : Math.max(0, firstOrderAt - entry.receivedAt),
      });
      if (running === entry) running = null;
      announce(entry);
    };
    try {
      runId = deps.startBuy({
        mint: entry.detection.mint,
        detectedAt: entry.detection.detectedAt,
        onFirstOrder: () => {
          if (firstOrderAt !== null) return;
          firstOrderAt = deps.perfNow();
          if (runId !== null) send();
        },
      });
    } catch (e) {
      update(entry, { problem: isAppError(e) ? e.code : 'INTERNAL_ERROR' });
      announce(entry);
      return;
    }
    if (ordered()) send();
    else {
      update(entry, { runId });
      // Announced at the first `/order`, or by `buyFinished` if the buy sends none.
      running = entry;
    }
  };

  const startNext = (): void => {
    while (!deps.isBuying()) {
      const next = queue.shift();
      if (next === undefined) return;
      begin(next);
    }
  };

  let stream: Stream | null = null;

  const stopStream = (): void => {
    stream?.stop();
    stream = null;
  };

  const onDetection = (d: Detection): void => {
    if (!isArmed()) return;
    if (entries.some((e) => e.detection.mint === d.mint)) return;
    const entry: Entry = {
      detection: {
        mint: d.mint,
        source: d.source,
        path: d.path,
        signature: d.signature,
        detectedAt: clock.now(),
        runId: null,
        reactionMs: null,
        verified: null,
        problem: null,
      },
      receivedAt: d.receivedAt,
    };
    entries.push(entry);
    // A live log is new by definition; a transaction must not be older than arming.
    if (d.blockTime !== null && d.blockTime * 1000 < armedAt - CATCH_UP_MAX_AGE_MS) {
      update(entry, { problem: 'STALE' });
      emit({ kind: 'watch', at: clock.now(), type: 'stale', detection: entry.detection });
      return;
    }
    if (options.mode === 'one-shot') {
      armed = false;
      stopStream();
      emit({ kind: 'watch', at: clock.now(), type: 'disarmed', reason: 'one-shot' });
    }
    if (deps.isBuying() || queue.length > 0) {
      queue.push(entry);
      emit({ kind: 'watch', at: clock.now(), type: 'queued', detection: entry.detection });
      return;
    }
    begin(entry);
  };

  const detector: Detector = createDetector(
    {
      getTransaction: deps.getTransaction,
      clock,
      emit: (event) => {
        if (event.kind === 'detection') onDetection(event.detection);
        else if (event.kind === 'verified') {
          const entry = entries.find((e) => e.detection.mint === event.mint);
          if (entry) update(entry, { verified: event.match });
          emit({
            kind: 'watch',
            at: clock.now(),
            type: 'verified',
            mint: event.mint,
            signature: event.signature,
            match: event.match,
          });
        }
      },
    },
    { watched: options.creator },
  );

  emit({ kind: 'watch', at: armedAt, type: 'armed', creator: options.creator, mode: options.mode });

  stream = startStream(
    {
      createWebSocket: deps.createWebSocket,
      signatures: deps.signatures,
      clock,
      receivedAt: deps.perfNow,
      random: deps.random,
      emit: (event) => {
        if (event.kind === 'signature') {
          detector.onSignature(event);
          return;
        }
        connection = {
          status: event.status,
          attempt: event.attempt,
          lastMessageAt: event.lastMessageAt,
        };
        emit({ kind: 'watch', at: clock.now(), type: 'connection', ...connection });
      },
    },
    { url: options.url, creator: options.creator },
  );

  // Balances every 30 s, so a detection never waits for them.
  void (async () => {
    for (;;) {
      await clock.sleep(options.balanceRefreshMs ?? BALANCE_REFRESH_MS);
      if (!isArmed()) return;
      try {
        await deps.refreshBalances();
      } catch {
        // The last read stays; the next refresh tries again.
      }
    }
  })();

  return {
    disarm() {
      const wasArmed = armed;
      armed = false;
      stopStream();
      detector.stop();
      for (const entry of queue.splice(0)) {
        update(entry, { problem: 'DISARMED' });
        announce(entry);
      }
      if (wasArmed) emit({ kind: 'watch', at: clock.now(), type: 'disarmed', reason: 'user' });
    },
    buyFinished() {
      if (running !== null) {
        announce(running);
        running = null;
      }
      startNext();
    },
    active: () => armed || queue.length > 0,
    status: () => ({
      creator: options.creator,
      armedAt: new Date(armedAt).toISOString(),
      mode: options.mode,
      armed,
      connection: connection.status,
      attempt: connection.attempt,
      lastMessageAt: connection.lastMessageAt,
      detections: entries.map((e) => e.detection),
      queued: queue.map((e) => e.detection.mint),
    }),
  };
}
