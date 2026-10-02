/**
 * Creator log stream (BUNNDLY-32, D-036): subscription, dedup, reconnect with backoff,
 * keep-alive, gap catch-up and no key in events. Fake WebSocket, fake clock, no network.
 */
import { describe, expect, it } from 'vitest';
import type { WebSocketLike } from '../../src/chain/connection-test.ts';
import {
  CATCH_UP_PAGE,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
  startStream,
  type SignatureInfo,
  type StreamEvent,
} from '../../src/watcher/stream.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';

const CREATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const URL = 'wss://mainnet.helius-rpc.com/?api-key=streamSecretKey123';

type Listener = (event: { readonly data: unknown }) => void;

class FakeSocket implements WebSocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly createdAt: number) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  open(): void {
    this.fire('open');
  }
  /** The server answers a request (any JSON-RPC message with its id). */
  reply(id: unknown): void {
    this.fire('message', JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601 } }));
  }
  notify(signature: string, err: unknown = null, logs: string[] = ['Program log: x']): void {
    this.fire(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: {
          result: { context: { slot: 1 }, value: { signature, err, logs } },
          subscription: 7,
        },
      }),
    );
  }
  sentMethods(): unknown[] {
    return this.sent.map((m) => m.method);
  }
}

interface Setup {
  /** Creator's signatures on the chain, newest first. */
  chain?: string[];
  random?: number;
  failSignatures?: boolean;
}

function setup(o: Setup = {}) {
  const clock = new FakeClock(true);
  const sockets: FakeSocket[] = [];
  const events: StreamEvent[] = [];
  const chain = o.chain ?? ['S0'];
  const calls: { limit: number; until?: string; before?: string }[] = [];
  let receive = 0;
  const stream = startStream(
    {
      createWebSocket: (url) => {
        expect(url).toBe(URL);
        const s = new FakeSocket(clock.now());
        sockets.push(s);
        return s;
      },
      signatures: (opts) => {
        calls.push(opts);
        if (o.failSignatures) return Promise.reject(new Error(`fetch ${URL} failed`));
        // newest first, strictly after `until`, strictly before `before`
        let list = [...chain];
        if (opts.until !== undefined) list = list.slice(0, Math.max(0, list.indexOf(opts.until)));
        if (opts.before !== undefined) list = list.slice(list.indexOf(opts.before) + 1);
        return Promise.resolve(
          list.slice(0, opts.limit).map((signature): SignatureInfo => ({ signature, err: null })),
        );
      },
      clock,
      receivedAt: () => ++receive,
      random: () => o.random ?? 1,
      emit: (e) => events.push(e),
    },
    { url: URL, creator: CREATOR },
  );
  const last = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  const statuses = () =>
    events.flatMap((e) =>
      e.kind === 'status' ? [`${e.status}${e.attempt ? `:${String(e.attempt)}` : ''}`] : [],
    );
  const signatures = () =>
    events.flatMap((e) => (e.kind === 'signature' ? [`${e.signature}/${e.source}`] : []));
  return { clock, sockets, events, stream, last, statuses, signatures, chain, calls };
}

describe('subscription', () => {
  it('one logsSubscribe for the creator at processed; failed and repeated signatures dropped', async () => {
    const { clock, last, events, signatures } = setup();
    await clock.settle();
    const ws = last();
    ws.open();
    expect(ws.sent.filter((m) => m.method === 'logsSubscribe')).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [CREATOR] }, { commitment: 'processed' }],
      },
    ]);
    ws.notify('A');
    ws.notify('B', { InstructionError: [0, 'x'] });
    ws.notify('A');
    ws.notify('C');
    expect(signatures()).toEqual(['A/logs', 'C/logs']);
    const a = events.find((e) => e.kind === 'signature');
    expect(a).toMatchObject({ logs: ['Program log: x'], receivedAt: 1 });
  });
});

describe('reconnect', () => {
  it('drop → reconnecting → connected, resubscribes; backoff grows to 30 s and resets', async () => {
    const { clock, sockets, last, statuses } = setup();
    await clock.settle();
    last().open();
    // nine failures in a row, never opening: delay from each close to the next socket
    const gaps: number[] = [];
    for (let i = 0; i < 9; i++) {
      const closedAt = clock.now();
      last().fire('close');
      await clock.runUntil(clock.now() + RECONNECT_MAX_MS);
      gaps.push(last().createdAt - closedAt);
    }
    expect(gaps).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(statuses().slice(0, 4)).toEqual([
      'connecting',
      'connected',
      'reconnecting:1',
      'reconnecting:2',
    ]);
    // success resets: the next drop waits 0,5 s again, and the new socket subscribes
    last().open();
    expect(statuses().at(-1)).toBe('connected');
    const before = sockets.length;
    last().fire('close');
    await clock.runUntil(clock.now() + 500);
    expect(sockets).toHaveLength(before + 1);
    last().open();
    expect(last().sentMethods()).toContain('logsSubscribe');
  });

  it('jitter keeps delays between half and the full step, never under 0,5 s', () => {
    expect(reconnectDelay(1, 0)).toBe(500);
    expect(reconnectDelay(4, 0)).toBe(2_000);
    expect(reconnectDelay(4, 1)).toBe(4_000);
    expect(reconnectDelay(20, 0.5)).toBe(22_500);
    expect(reconnectDelay(20, 1)).toBe(30_000);
  });

  it('stop: disconnected, socket closed, no more reconnects', async () => {
    const { clock, sockets, last, stream, statuses } = setup();
    await clock.settle();
    last().open();
    stream.stop();
    expect(last().closed).toBe(true);
    await clock.runUntil(clock.now() + 120_000);
    expect(sockets).toHaveLength(1);
    expect(statuses().at(-1)).toBe('disconnected');
  });
});

describe('keep-alive', () => {
  it('a request every 30 s; answered: the connection stays', async () => {
    const { clock, sockets, last } = setup();
    await clock.settle();
    const ws = last();
    ws.open();
    for (let i = 1; i <= 3; i++) {
      await clock.runUntil(T0 + i * KEEPALIVE_INTERVAL_MS + (i - 1) * KEEPALIVE_TIMEOUT_MS);
      const ping = ws.sent.at(-1);
      expect(ping?.method).toBe('getHealth');
      ws.reply(ping?.id);
      await clock.runUntil(clock.now() + KEEPALIVE_TIMEOUT_MS);
    }
    expect(sockets).toHaveLength(1);
    expect(ws.closed).toBe(false);
  });

  it('no answer in 10 s: closed and reconnected; found within 40 s', async () => {
    const { clock, sockets, last, statuses } = setup();
    await clock.settle();
    const ws = last();
    ws.open();
    await clock.runUntil(T0 + KEEPALIVE_INTERVAL_MS + KEEPALIVE_TIMEOUT_MS);
    expect(ws.closed).toBe(true);
    expect(statuses()).toContain('reconnecting:1');
    expect(clock.now() - T0).toBeLessThanOrEqual(40_000);
    await clock.runUntil(clock.now() + 500);
    expect(sockets).toHaveLength(2);
  });
});

describe('gap catch-up', () => {
  it('signatures from the gap pass once, oldest first, as catch-up; also seen live → once', async () => {
    const { clock, last, signatures, chain, calls } = setup({ chain: ['S0'] });
    await clock.settle();
    last().open();
    await clock.settle();
    expect(calls[0]).toEqual({ limit: 1 }); // the baseline at arming
    last().fire('close');
    // while disconnected the creator sends three transactions
    chain.unshift('S1');
    chain.unshift('S2');
    chain.unshift('S3');
    await clock.runUntil(clock.now() + 500);
    last().open();
    await clock.settle();
    last().notify('S3'); // also seen live afterwards
    last().notify('S4');
    expect(signatures()).toEqual(['S1/catch-up', 'S2/catch-up', 'S3/catch-up', 'S4/logs']);
    expect(calls.at(-1)).toEqual({ limit: CATCH_UP_PAGE, until: 'S0' });
  });

  it('a long gap is read page by page, every signature once, oldest first', async () => {
    const { clock, last, signatures, chain, calls } = setup({ chain: ['G0'] });
    await clock.settle();
    last().open();
    await clock.settle();
    last().fire('close');
    // 2 500 transactions while disconnected (newest first: G2500 … G1)
    for (let i = 1; i <= 2_500; i++) chain.unshift(`G${String(i)}`);
    calls.length = 0;
    await clock.runUntil(clock.now() + 500);
    last().open();
    await clock.settle();
    expect(calls.map((c) => c.before ?? null)).toEqual([null, 'G1501', 'G501']);
    expect(calls.every((c) => c.until === 'G0' && c.limit === CATCH_UP_PAGE)).toBe(true);
    const got = signatures();
    expect(got).toHaveLength(2_500);
    expect(got[0]).toBe('G1/catch-up');
    expect(got.at(-1)).toBe('G2500/catch-up');
    expect(new Set(got).size).toBe(2_500);
  });

  it('nothing is forwarded without a baseline (the RPC failed), and no error text leaks', async () => {
    const { clock, last, signatures, events } = setup({ failSignatures: true });
    await clock.settle();
    last().open();
    last().notify('L1');
    await clock.runUntil(clock.now() + 5_000);
    expect(signatures()).toEqual(['L1/logs']);
    expect(JSON.stringify(events)).not.toContain('streamSecretKey123');
  });
});

describe('the key never leaves', () => {
  it('no event carries the URL or the key, also when the socket cannot be created', async () => {
    const clock = new FakeClock(true);
    const events: StreamEvent[] = [];
    let n = 0;
    const stream = startStream(
      {
        createWebSocket: (url) => {
          n += 1;
          throw new Error(`cannot connect to ${url}`);
        },
        signatures: () => Promise.resolve([]),
        clock,
        receivedAt: () => 0,
        random: () => 0,
        emit: (e) => events.push(e),
      },
      { url: URL, creator: CREATOR },
    );
    await clock.runUntil(T0 + 10_000);
    stream.stop();
    expect(n).toBeGreaterThan(2);
    const text = JSON.stringify(events);
    expect(text).not.toContain('streamSecretKey123');
    expect(text).not.toContain('helius-rpc.com');
  });
});
