/**
 * Live SOL balances of the fleet (BUNNDLY-57, D-055): one Helius WebSocket with an
 * `accountSubscribe` per wallet at `confirmed`. A notification changes the balance of its
 * wallet only. The feed is `live` once every wallet of the socket is subscribed and
 * `polling` otherwise: the caller then keeps reading with `getMultipleAccounts`.
 *
 * The keep-alive and the reconnect backoff are the watcher's (src/watcher/stream.ts).
 * The URL carries the Helius key: it never appears in events, and WebSocket errors are
 * dropped (D-024). Pure logic with an injected socket factory, clock and randomness.
 */
import {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_TIMEOUT_MS,
  SUBSCRIBE_TIMEOUT_MS,
  reconnectDelay,
} from '../watcher/stream.ts';
import type { WebSocketFactory, WebSocketLike } from './connection-test.ts';

/** `live`: every wallet is subscribed. `polling`: anything else (connecting, lost). */
export type FeedState = 'live' | 'polling';

export type BalanceStreamEvent =
  | { readonly kind: 'feed'; readonly state: FeedState }
  | {
      readonly kind: 'lamports';
      readonly index: number;
      readonly lamports: bigint;
      readonly slot: number;
    };

export interface FeedWallet {
  readonly index: number;
  readonly address: string;
}

export interface BalanceStreamDeps {
  readonly createWebSocket: WebSocketFactory;
  readonly clock: { sleep(ms: number): Promise<void> };
  readonly random: () => number;
  readonly emit: (event: BalanceStreamEvent) => void;
}

export interface BalanceStreamOptions {
  /** Helius WebSocket URL with the key. Never leaves this module. */
  readonly url: string;
  readonly wallets: readonly FeedWallet[];
}

export interface BalanceStream {
  /** Subscribes wallets added to the fleet; the ones already watched stay. */
  add(wallets: readonly FeedWallet[]): void;
  /** Closes the socket (and with it every subscription) and stops reconnecting. */
  stop(): void;
  /** Subscriptions the server confirmed on the current socket. */
  subscriptions(): number;
  state(): FeedState;
}

/** Ids of our requests: subscriptions count up from here, keep-alives from KEEPALIVE_BASE. */
const SUBSCRIBE_BASE = 1;
const KEEPALIVE_BASE = 1_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function startBalanceStream(
  deps: BalanceStreamDeps,
  options: BalanceStreamOptions,
): BalanceStream {
  const { clock } = deps;
  const wallets: FeedWallet[] = [...options.wallets];
  let stopped = false;
  /** Bumped for every socket: callbacks of an older socket are ignored. */
  let generation = 0;
  let socket: WebSocketLike | null = null;
  let opened = false;
  let attempt = 0;
  let feed: FeedState = 'polling';
  let nextId = SUBSCRIBE_BASE;
  let keepaliveId = KEEPALIVE_BASE;
  let pendingKeepalive: number | null = null;
  /** Request id → wallet index, while the server has not answered the subscription. */
  let pending = new Map<number, number>();
  /** Subscription id → wallet index, on the current socket. */
  let subs = new Map<number, number>();
  const isStopped = (): boolean => stopped;
  const awaitingKeepalive = (id: number): boolean => pendingKeepalive === id;

  const setFeed = (next: FeedState): void => {
    if (feed === next) return;
    feed = next;
    deps.emit({ kind: 'feed', state: next });
  };

  const subscribed = (): Set<number> => new Set([...subs.values(), ...pending.values()]);

  /** Every wallet has a confirmed subscription on this socket. */
  const complete = (): boolean => {
    const confirmed = new Set(subs.values());
    return wallets.every((w) => confirmed.has(w.index));
  };

  const subscribe = (gen: number, ws: WebSocketLike, list: readonly FeedWallet[]): void => {
    for (const w of list) {
      const id = nextId++;
      pending.set(id, w.index);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'accountSubscribe',
          // Only lamports are read; base64 is the smallest encoding of a system account.
          params: [w.address, { encoding: 'base64', commitment: 'confirmed' }],
        }),
      );
    }
    void clock.sleep(SUBSCRIBE_TIMEOUT_MS).then(() => {
      // A subscription still unanswered: the connection does not work.
      if (gen === generation && !stopped && list.some((w) => !confirmedNow(w.index))) lost(gen);
    });
  };
  const confirmedNow = (index: number): boolean => [...subs.values()].includes(index);

  const onMessage = (gen: number, data: unknown): void => {
    if (gen !== generation || stopped || typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === 'number') {
      if (message.id === pendingKeepalive) {
        pendingKeepalive = null; // any answer, result or error, proves the connection lives
        return;
      }
      const index = pending.get(message.id);
      if (index === undefined) return;
      pending.delete(message.id);
      if (typeof message.result !== 'number') {
        lost(gen); // a refused subscription: reconnect and subscribe everything again
        return;
      }
      subs.set(message.result, index);
      attempt = 0;
      if (complete()) setFeed('live');
      return;
    }
    if (message.method !== 'accountNotification' || !isRecord(message.params)) return;
    const index =
      typeof message.params.subscription === 'number'
        ? subs.get(message.params.subscription)
        : undefined;
    if (index === undefined) return;
    const result = message.params.result;
    if (!isRecord(result)) return;
    const slot = isRecord(result.context) ? result.context.slot : undefined;
    const value = result.value;
    // A closed account has no value: it holds nothing.
    const lamports = value === null ? 0 : isRecord(value) ? value.lamports : undefined;
    // JSON numbers above 2^53 lose digits; the next full read gives the exact amount.
    if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) return;
    deps.emit({
      kind: 'lamports',
      index,
      lamports: BigInt(lamports),
      slot: typeof slot === 'number' ? slot : 0,
    });
  };

  /** Every 30 s a request that any server answers; no answer in 10 s means dead. */
  const keepalive = async (gen: number, ws: WebSocketLike): Promise<void> => {
    for (;;) {
      await clock.sleep(KEEPALIVE_INTERVAL_MS);
      if (isStopped() || gen !== generation) return;
      keepaliveId += 1;
      const id = keepaliveId;
      pendingKeepalive = id;
      // Not a pubsub method: the server answers with an error at once, which is enough.
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'getHealth' }));
      await clock.sleep(KEEPALIVE_TIMEOUT_MS);
      if (isStopped() || gen !== generation) return;
      if (awaitingKeepalive(id)) {
        lost(gen);
        return;
      }
    }
  };

  const connect = (): void => {
    if (stopped) return;
    generation += 1;
    const gen = generation;
    opened = false;
    pending = new Map();
    subs = new Map();
    pendingKeepalive = null;
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
      opened = true;
      subscribe(gen, ws, wallets);
      void keepalive(gen, ws);
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

  /** The socket of `gen` is gone: polling until a new one has every subscription. */
  const lost = (gen: number): void => {
    if (gen !== generation || stopped) return;
    generation += 1; // ignore anything more from that socket
    try {
      socket?.close();
    } catch {
      // already closed
    }
    socket = null;
    opened = false;
    pending = new Map();
    subs = new Map();
    attempt += 1;
    setFeed('polling');
    void clock.sleep(reconnectDelay(attempt, deps.random())).then(connect);
  };

  connect();

  return {
    add(list) {
      if (stopped) return;
      const known = new Set(wallets.map((w) => w.index));
      const fresh = list.filter((w) => !known.has(w.index));
      if (fresh.length === 0) return;
      wallets.push(...fresh);
      const ws = socket;
      if (opened && ws !== null) {
        const already = subscribed();
        subscribe(
          generation,
          ws,
          fresh.filter((w) => !already.has(w.index)),
        );
      }
    },
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
      pending = new Map();
      subs = new Map();
      feed = 'polling';
    },
    subscriptions: () => subs.size,
    state: () => feed,
  };
}
