/**
 * Log stream of the watched creator (SPEC 3.4, BUNNDLY-32, D-036): Helius WebSocket
 * `logsSubscribe` with `mentions: [creator]` at `processed`, kept alive, reconnected with
 * backoff, and gaps filled from `getSignaturesForAddress`. Runs only in the vault worker.
 *
 * The URL carries the Helius key: it never appears in events, and WebSocket errors are
 * dropped (D-024); the outside sees connection states and signatures only.
 *
 * Pure logic with an injected socket factory, signature reader, clock and randomness.
 */
import type { WebSocketFactory, WebSocketLike } from '../chain/connection-test.ts';

/** Keep-alive request every 30 s (Helius closes after 10 min without traffic). */
export const KEEPALIVE_INTERVAL_MS = 30_000;
/** No answer to the keep-alive within this: the connection is dead (found ≤ 40 s). */
export const KEEPALIVE_TIMEOUT_MS = 10_000;
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 30_000;
/** Signatures remembered for deduplication. */
export const DEDUP_SIZE = 2_000;
/** Page size of the gap catch-up (`getSignaturesForAddress` allows up to 1000). */
export const CATCH_UP_PAGE = 1_000;
/** The catch-up never reads more pages than this. */
export const CATCH_UP_MAX_PAGES = 10;
/**
 * The catch-up passes on only transactions from at most this long before arming (block
 * time); older ones are never a new launch to buy (review of PR #26).
 */
export const CATCH_UP_MAX_AGE_MS = 60_000;
/** No answer to `logsSubscribe` within this: treated as a lost connection. */
export const SUBSCRIBE_TIMEOUT_MS = 10_000;

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type StreamEvent =
  | {
      readonly kind: 'status';
      readonly status: StreamStatus;
      /** Reconnect attempt (1, 2, …) while `reconnecting`, else 0. */
      readonly attempt: number;
      /** Last message from the socket (clock ms), or null. */
      readonly lastMessageAt: number | null;
    }
  | {
      readonly kind: 'signature';
      readonly signature: string;
      /** `logs`: from the live stream, with its log lines. `catch-up`: from the gap, no logs. */
      readonly source: 'logs' | 'catch-up';
      readonly logs: readonly string[] | null;
      /** `performance.now()` in the worker when it arrived (BUNNDLY-34: reaction time). */
      readonly receivedAt: number;
    };

export interface SignatureInfo {
  readonly signature: string;
  readonly err: unknown;
  /** Unix seconds; null when the node does not know it yet (a new transaction). */
  readonly blockTime: number | bigint | null;
}

/** `getSignaturesForAddress(creator, …)` at `confirmed`, newest first. May throw. */
export type SignatureReader = (options: {
  readonly limit: number;
  readonly until?: string;
  readonly before?: string;
}) => Promise<readonly SignatureInfo[]>;

export interface StreamClock {
  /** Unix time in ms (`Date.now()`): compared with block times, never `performance.now()`. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** 2020-01-01: any Unix-ms clock is past it; `performance.now()` never is. */
const UNIX_MS_FLOOR = Date.UTC(2020, 0, 1);

/**
 * The catch-up bound and the stale-transaction check compare `clock.now()` with
 * `blockTime × 1000`; a monotonic clock starting near 0 would let everything through
 * (review of PR #26). Fails arming instead.
 */
export function assertUnixMsClock(clock: StreamClock): void {
  if (!(clock.now() >= UNIX_MS_FLOOR)) throw new Error('stream clock must be Unix time in ms');
}

export interface StreamDeps {
  readonly createWebSocket: WebSocketFactory;
  readonly signatures: SignatureReader;
  readonly clock: StreamClock;
  /** High-resolution receive time (`performance.now()` in the worker). */
  readonly receivedAt: () => number;
  readonly random: () => number;
  readonly emit: (event: StreamEvent) => void;
}

export interface StreamOptions {
  /** Helius WebSocket URL with the key. Never leaves this module. */
  readonly url: string;
  /** The watched address (one address: `mentions` takes exactly one). */
  readonly creator: string;
}

export interface Stream {
  /** Closes the socket and stops reconnecting; emits `disconnected`. */
  stop(): void;
}

/** Reconnect delay for attempt n (1, 2, …): exponential, jittered, 0,5 s … 30 s. */
export function reconnectDelay(attempt: number, random: number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempt - 1));
  return Math.max(RECONNECT_MIN_MS, Math.round(ceiling * (0.5 + random / 2)));
}

const SUBSCRIBE_ID = 1;
const FIRST_KEEPALIVE_ID = 1_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function startStream(deps: StreamDeps, options: StreamOptions): Stream {
  const { clock } = deps;
  assertUnixMsClock(clock);
  let stopped = false;
  /** Bumped for every socket: callbacks of an older socket are ignored. */
  let generation = 0;
  let socket: WebSocketLike | null = null;
  let attempt = 0;
  let lastMessageAt: number | null = null;
  let keepaliveId = FIRST_KEEPALIVE_ID;
  let pendingKeepalive: number | null = null;
  // Read through functions: callbacks change these while an async loop awaits.
  const isStopped = (): boolean => stopped;
  const awaitingKeepalive = (id: number): boolean => pendingKeepalive === id;

  const seen = new Set<string>();
  const seenOrder: string[] = [];
  /**
   * Newest signature of the `confirmed` history known to us: the baseline or the newest
   * catch-up result, never a `processed` log. `until` with a signature that is not in the
   * history does not stop, so a live log here would read the creator's whole past.
   */
  let lastSeen: string | null = null;
  let baselineDone = false;
  /** Oldest block time (Unix ms) the catch-up passes on. */
  const notBefore = clock.now() - CATCH_UP_MAX_AGE_MS;
  const isRecent = (info: SignatureInfo): boolean =>
    info.blockTime === null || Number(info.blockTime) * 1000 >= notBefore;

  const status = (s: StreamStatus): void => {
    deps.emit({
      kind: 'status',
      status: s,
      attempt: s === 'reconnecting' ? attempt : 0,
      lastMessageAt,
    });
  };

  /** Passes a signature on once; false if it was already seen. */
  const pass = (
    signature: string,
    source: 'logs' | 'catch-up',
    logs: readonly string[] | null,
  ): void => {
    if (seen.has(signature)) return;
    seen.add(signature);
    seenOrder.push(signature);
    if (seenOrder.length > DEDUP_SIZE) {
      const old = seenOrder.shift();
      if (old !== undefined) seen.delete(old);
    }
    deps.emit({ kind: 'signature', signature, source, logs, receivedAt: deps.receivedAt() });
  };

  /** Newest signature at arming: the catch-up never reaches further back. */
  const baseline = async (): Promise<void> => {
    for (let i = 0; !baselineDone && !stopped; i++) {
      try {
        const [newest] = await deps.signatures({ limit: 1 });
        lastSeen ??= newest?.signature ?? null;
        baselineDone = true;
      } catch {
        await clock.sleep(reconnectDelay(i + 1, deps.random()));
      }
    }
  };

  /**
   * Signatures after `lastSeen`, oldest first, exactly once, and only from block times
   * at most 60 s before arming; at most 10 pages. Without a baseline there is no safe
   * lower bound: nothing is forwarded (D-036).
   */
  const catchUp = async (gen: number): Promise<void> => {
    if (!baselineDone) await baseline();
    if (stopped || gen !== generation) return;
    const until = lastSeen;
    if (until === null) return; // the creator had no transactions yet: nothing missed
    const found: SignatureInfo[] = [];
    let before: string | undefined;
    try {
      for (let pages = 0; pages < CATCH_UP_MAX_PAGES; pages++) {
        const page = await deps.signatures({
          limit: CATCH_UP_PAGE,
          until,
          ...(before === undefined ? {} : { before }),
        });
        found.push(...page);
        // Newest first: once a page reaches older transactions, the rest is older too.
        if (page.length < CATCH_UP_PAGE || !page.every(isRecent)) break;
        before = page.at(-1)?.signature;
        if (before === undefined) break;
      }
    } catch {
      return; // the next reconnect tries again from the same `lastSeen`
    }
    if (isStopped()) return;
    for (const info of [...found].reverse()) {
      if (info.err === null && isRecent(info)) pass(info.signature, 'catch-up', null);
    }
    const newest = found[0]?.signature;
    if (newest !== undefined) lastSeen = newest;
  };

  const onMessage = (gen: number, data: unknown): void => {
    if (gen !== generation || typeof data !== 'string') return;
    lastMessageAt = clock.now();
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === 'number' && message.id === pendingKeepalive) {
      pendingKeepalive = null; // any answer, result or error, proves the connection lives
      return;
    }
    if (message.id === SUBSCRIBE_ID) {
      onSubscribed(gen, typeof message.result === 'number' ? message.result : null);
      return;
    }
    if (message.method !== 'logsNotification' || !isRecord(message.params)) return;
    const result = message.params.result;
    const value = isRecord(result) ? result.value : undefined;
    if (!isRecord(value) || typeof value.signature !== 'string') return;
    if (value.err !== null && value.err !== undefined) return; // failed transaction
    const logs = Array.isArray(value.logs)
      ? value.logs.filter((l): l is string => typeof l === 'string')
      : [];
    pass(value.signature, 'logs', logs);
  };

  /** Every 30 s a request that any server answers; no answer in 10 s means dead. */
  const keepalive = async (gen: number, ws: WebSocketLike): Promise<void> => {
    for (;;) {
      await clock.sleep(KEEPALIVE_INTERVAL_MS);
      if (stopped || gen !== generation) return;
      keepaliveId += 1;
      const id = keepaliveId;
      pendingKeepalive = id;
      // `getHealth` is not a pubsub method: the server answers with an error at once,
      // which is enough. It subscribes to nothing and cannot touch our subscription.
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'getHealth' }));
      await clock.sleep(KEEPALIVE_TIMEOUT_MS);
      if (isStopped() || gen !== generation) return;
      if (awaitingKeepalive(id)) {
        lost(gen); // dead connection
        return;
      }
    }
  };

  /** Waits for the subscription of the socket `gen` to be confirmed. */
  let subscribedGen = 0;
  const isSubscribed = (gen: number): boolean => subscribedGen === gen;

  /**
   * Answer to `logsSubscribe`: a subscription id makes the stream `connected` and starts
   * the keep-alive and the catch-up; an error is a lost connection (backoff, reconnect).
   */
  const onSubscribed = (gen: number, subscription: number | null): void => {
    if (gen !== generation || stopped || isSubscribed(gen)) return;
    const ws = socket;
    if (subscription === null || ws === null) {
      lost(gen);
      return;
    }
    subscribedGen = gen;
    attempt = 0;
    status('connected');
    void keepalive(gen, ws);
    void catchUp(gen);
  };

  const connect = (): void => {
    if (stopped) return;
    generation += 1;
    const gen = generation;
    pendingKeepalive = null;
    // A reconnect already said `reconnecting` when the old socket was lost.
    if (attempt === 0) status('connecting');
    let ws: WebSocketLike;
    try {
      ws = deps.createWebSocket(options.url);
    } catch {
      lost(gen);
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      if (gen !== generation || stopped) return;
      // Not `connected` yet: only a confirmed subscription is (review of PR #26).
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: SUBSCRIBE_ID,
          method: 'logsSubscribe',
          params: [{ mentions: [options.creator] }, { commitment: 'processed' }],
        }),
      );
      void clock.sleep(SUBSCRIBE_TIMEOUT_MS).then(() => {
        if (!isSubscribed(gen)) lost(gen);
      });
    });
    ws.addEventListener('message', (event) => {
      onMessage(gen, event.data);
    });
    // The error object may carry the URL with the key: it is never read (D-024).
    ws.addEventListener('error', () => {
      lost(gen);
    });
    ws.addEventListener('close', () => {
      lost(gen);
    });
  };

  /** The socket of `gen` is gone: close it and reconnect after a backoff. */
  const lost = (gen: number): void => {
    if (gen !== generation || stopped) return;
    generation += 1; // ignore anything more from that socket
    try {
      socket?.close();
    } catch {
      // already closed
    }
    socket = null;
    attempt += 1;
    status('reconnecting');
    void clock.sleep(reconnectDelay(attempt, deps.random())).then(connect);
  };

  void baseline();
  connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      try {
        socket?.close();
      } catch {
        // already closed
      }
      socket = null;
      status('disconnected');
    },
  };
}
