/**
 * Creator log stream (BUNNDLY-32, D-036): subscription, dedup, reconnect with backoff,
 * keep-alive, gap catch-up and no key in events. Fake WebSocket, fake clock, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_MAX_PAGES,
  CATCH_UP_PAGE,
  SUBSCRIBE_TIMEOUT_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
  startStream,
  type SignatureInfo,
  type StreamEvent,
} from '../../src/watcher/stream.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';

const CREATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const URL = 'wss://mainnet.helius-rpc.com/?api-key=streamSecretKey123';

interface Setup {
  /** Creator's signatures on the chain, newest first. */
  chain?: string[];
  /** Block time (Unix s) of a signature; null (not known yet: new) when missing. */
  blockTimes?: Record<string, number>;
  /** Newest signature the RPC reports at arming, if not the chain's first. */
  baseline?: string;
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
        if (opts.until === undefined && opts.before === undefined && o.baseline !== undefined) {
          return Promise.resolve([{ signature: o.baseline, err: null, blockTime: null }]);
        }
        // newest first, strictly after `until`, strictly before `before`. Like the real
        // RPC, an `until` that is not in the history does not stop the list (review #26).
        let list = [...chain];
        if (opts.until !== undefined && list.includes(opts.until)) {
          list = list.slice(0, list.indexOf(opts.until));
        }
        if (opts.before !== undefined) list = list.slice(list.indexOf(opts.before) + 1);
        return Promise.resolve(
          list.slice(0, opts.limit).map((signature): SignatureInfo => ({
            signature,
            err: null,
            blockTime: o.blockTimes?.[signature] ?? null,
          })),
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
    ws.connect();
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
    last().connect();
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
    last().connect();
    expect(statuses().at(-1)).toBe('connected');
    const before = sockets.length;
    last().fire('close');
    await clock.runUntil(clock.now() + 500);
    expect(sockets).toHaveLength(before + 1);
    last().connect();
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
    last().connect();
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
    ws.connect();
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
    ws.connect();
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
    last().connect();
    await clock.settle();
    expect(calls[0]).toEqual({ limit: 1 }); // the baseline at arming
    last().fire('close');
    // while disconnected the creator sends three transactions
    chain.unshift('S1');
    chain.unshift('S2');
    chain.unshift('S3');
    await clock.runUntil(clock.now() + 500);
    last().connect();
    await clock.settle();
    last().notify('S3'); // also seen live afterwards
    last().notify('S4');
    expect(signatures()).toEqual(['S1/catch-up', 'S2/catch-up', 'S3/catch-up', 'S4/logs']);
    expect(calls.at(-1)).toEqual({ limit: CATCH_UP_PAGE, until: 'S0' });
  });

  it('a long gap is read page by page, every signature once, oldest first', async () => {
    const { clock, last, signatures, chain, calls } = setup({ chain: ['G0'] });
    await clock.settle();
    last().connect();
    await clock.settle();
    last().fire('close');
    // 2 500 transactions while disconnected (newest first: G2500 … G1)
    for (let i = 1; i <= 2_500; i++) chain.unshift(`G${String(i)}`);
    calls.length = 0;
    await clock.runUntil(clock.now() + 500);
    last().connect();
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
    last().connect();
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

describe('catch-up bounds (review of PR #26)', () => {
  const NOW_S = Math.floor(T0 / 1000);
  const OLD = NOW_S - 3_600; // an hour before arming
  const RECENT = NOW_S - 30; // within 60 s before arming

  it('a live log missing from the confirmed history, then a quick reconnect: nothing from before arming', async () => {
    const chain = ['S0', 'Old1', 'Old2'];
    const { clock, last, signatures, calls } = setup({
      chain,
      blockTimes: { S0: OLD, Old1: OLD - 10, Old2: OLD - 20 },
    });
    await clock.settle();
    last().connect();
    await clock.settle();
    last().notify('L1'); // processed: not (yet, or ever) in the confirmed history
    last().fire('close');
    await clock.runUntil(clock.now() + 500);
    last().connect();
    await clock.settle();
    // the boundary is still the confirmed baseline, not the live log
    expect(calls.filter((c) => c.until !== undefined).map((c) => c.until)).toEqual(['S0', 'S0']);
    expect(signatures()).toEqual(['L1/logs']);
  });

  it('`until` not found: only signatures from at most 60 s before arming; paging stops at the time bound', async () => {
    // newest first: 1 200 recent, then 2 000 old
    const recent = Array.from({ length: 1_200 }, (_, i) => `R${String(1_200 - i)}`);
    const old = Array.from({ length: 2_000 }, (_, i) => `O${String(i)}`);
    const blockTimes: Record<string, number> = {};
    for (const r of recent) blockTimes[r] = RECENT;
    for (const x of old) blockTimes[x] = OLD;
    // one recent one without a block time yet: counts as new
    delete blockTimes.R1200;
    const { clock, last, signatures, calls } = setup({
      chain: [...recent, ...old],
      blockTimes,
      baseline: 'Gone', // a signature the history no longer has
    });
    await clock.settle();
    last().connect();
    await clock.settle();
    const pages = calls.filter((c) => c.until === 'Gone');
    expect(pages).toHaveLength(2); // the second page reached old transactions: stop
    const got = signatures();
    expect(got).toHaveLength(1_200);
    expect(got.every((g) => g.startsWith('R'))).toBe(true);
    expect(got[0]).toBe('R1/catch-up');
    expect(got.at(-1)).toBe('R1200/catch-up');
  });

  it('at most 10 pages', async () => {
    const chain = Array.from({ length: 12_500 }, (_, i) => `N${String(12_500 - i)}`);
    const { clock, last, signatures, calls } = setup({ chain, baseline: 'Gone' });
    await clock.settle();
    last().connect();
    await clock.settle();
    expect(calls.filter((c) => c.until === 'Gone')).toHaveLength(CATCH_UP_MAX_PAGES);
    expect(signatures()).toHaveLength(CATCH_UP_MAX_PAGES * CATCH_UP_PAGE);
  });
});

describe('connected only with a subscription (review of PR #26)', () => {
  it('an open socket is not connected until logsSubscribe is confirmed', async () => {
    const { clock, last, statuses } = setup();
    await clock.settle();
    last().open();
    await clock.settle();
    expect(statuses()).toEqual(['connecting']);
    last().subscribed();
    expect(statuses()).toEqual(['connecting', 'connected']);
  });

  it('a subscription error is a lost connection: reconnecting, backoff, a new subscription', async () => {
    const { clock, sockets, last, statuses } = setup();
    await clock.settle();
    last().open();
    last().fire(
      'message',
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid' } }),
    );
    expect(last().closed).toBe(true);
    expect(statuses()).toEqual(['connecting', 'reconnecting:1']);
    await clock.runUntil(clock.now() + 500);
    expect(sockets).toHaveLength(2);
    last().connect();
    expect(statuses().at(-1)).toBe('connected');
  });

  it('no answer to logsSubscribe within 10 s: reconnecting, never connected', async () => {
    const { clock, sockets, last, statuses } = setup();
    await clock.settle();
    last().open();
    await clock.runUntil(T0 + SUBSCRIBE_TIMEOUT_MS);
    expect(statuses()).toEqual(['connecting', 'reconnecting:1']);
    await clock.runUntil(clock.now() + 500);
    expect(sockets).toHaveLength(2);
  });
});

describe('the clock is Unix time in ms (review of PR #26)', () => {
  it('a performance.now()-like clock fails at once: block times would all look recent', () => {
    // `sleep` never resolves: without the guard the test fails instead of spinning
    const clock = { now: () => 12_345.6, sleep: () => new Promise<void>(() => undefined) };
    expect(() =>
      startStream(
        {
          createWebSocket: () => {
            throw new Error('must not connect');
          },
          signatures: () => Promise.resolve([]),
          clock,
          receivedAt: () => 0,
          random: () => 0,
          emit: () => undefined,
        },
        { url: URL, creator: CREATOR },
      ),
    ).toThrow(/Unix time in ms/u);
  });
});
