/**
 * Live balances (BUNNDLY-57, D-051): one socket, one `accountSubscribe` per wallet, a
 * notification changes only its wallet, polling until every wallet is subscribed, the
 * watcher's keep-alive and backoff, nothing from a closed socket. Fake WebSocket and
 * clock, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  startBalanceStream,
  type BalanceStreamEvent,
  type FeedWallet,
} from '../../src/chain/balance-stream.ts';
import {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_TIMEOUT_MS,
  SUBSCRIBE_TIMEOUT_MS,
} from '../../src/watcher/stream.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';

const URL = 'wss://mainnet.helius-rpc.com/?api-key=streamSecretKey123';

const wallet = (index: number): FeedWallet => ({ index, address: `Wallet${String(index)}` });

/** The server's subscription id for a wallet: unrelated to its index on purpose. */
const subIdOf = (index: number): number => 9_000 + index * 7;

function setup(count = 3) {
  const clock = new FakeClock(true);
  const sockets: FakeSocket[] = [];
  const events: BalanceStreamEvent[] = [];
  const stream = startBalanceStream(
    {
      createWebSocket: (url) => {
        expect(url).toBe(URL);
        const s = new FakeSocket(clock.now());
        sockets.push(s);
        return s;
      },
      clock,
      random: () => 0.5,
      emit: (e) => events.push(e),
    },
    { url: URL, wallets: Array.from({ length: count }, (_, i) => wallet(i)) },
  );
  const last = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  /** The `accountSubscribe` requests of a socket: request id and address. */
  const subscribes = (s: FakeSocket) =>
    s.sent
      .filter((m) => m.method === 'accountSubscribe')
      .map((m) => ({ id: m.id as number, params: m.params as [string, Record<string, unknown>] }));
  /** The server confirms every subscription it was asked for, not confirmed yet. */
  const confirmAll = (s: FakeSocket, answered = new Set<number>()) => {
    for (const { id, params } of subscribes(s)) {
      if (answered.has(id)) continue;
      answered.add(id);
      const index = Number(params[0].replace('Wallet', ''));
      s.message({ jsonrpc: '2.0', id, result: subIdOf(index) });
    }
    return answered;
  };
  const notify = (s: FakeSocket, index: number, lamports: number | null, slot = 100) => {
    s.message({
      jsonrpc: '2.0',
      method: 'accountNotification',
      params: {
        result: {
          context: { slot },
          value:
            lamports === null
              ? null
              : {
                  data: ['', 'base64'],
                  executable: false,
                  lamports,
                  owner: '11111111111111111111111111111111',
                  rentEpoch: 0,
                  space: 0,
                },
        },
        subscription: subIdOf(index),
      },
    });
  };
  const lamports = () =>
    events.filter(
      (e): e is Extract<BalanceStreamEvent, { kind: 'lamports' }> => e.kind === 'lamports',
    );
  const feeds = () =>
    events.filter((e) => e.kind === 'feed').map((e) => (e as { state: string }).state);
  return { clock, sockets, events, stream, last, subscribes, confirmAll, notify, lamports, feeds };
}

describe('live balances: subscriptions', () => {
  it('one socket, one accountSubscribe per wallet at confirmed; live only when all are confirmed', async () => {
    const t = setup(3);
    expect(t.sockets).toHaveLength(1);
    expect(t.stream.state()).toBe('polling');
    t.last().open();
    const subs = t.subscribes(t.last());
    expect(subs.map((s) => s.params[0])).toEqual(['Wallet0', 'Wallet1', 'Wallet2']);
    for (const s of subs)
      expect(s.params[1]).toEqual({ encoding: 'base64', commitment: 'confirmed' });
    // two of three confirmed: still polling
    t.last().message({ jsonrpc: '2.0', id: subs[0]?.id, result: subIdOf(0) });
    t.last().message({ jsonrpc: '2.0', id: subs[1]?.id, result: subIdOf(1) });
    expect(t.stream.state()).toBe('polling');
    expect(t.stream.subscriptions()).toBe(2);
    t.last().message({ jsonrpc: '2.0', id: subs[2]?.id, result: subIdOf(2) });
    expect(t.stream.state()).toBe('live');
    expect(t.stream.subscriptions()).toBe(3);
    expect(t.feeds()).toEqual(['live']);
    await t.clock.settle();
  });

  it('100 wallets: 100 subscriptions on the one socket', () => {
    const t = setup(100);
    t.last().open();
    t.confirmAll(t.last());
    expect(t.sockets).toHaveLength(1);
    expect(t.subscribes(t.last())).toHaveLength(100);
    expect(t.stream.subscriptions()).toBe(100);
    expect(t.stream.state()).toBe('live');
  });

  it('a notification for wallet k gives the lamports of wallet k only', () => {
    const t = setup(3);
    t.last().open();
    t.confirmAll(t.last());
    t.notify(t.last(), 1, 2_500_000_001, 321);
    expect(t.lamports()).toEqual([
      { kind: 'lamports', index: 1, lamports: 2_500_000_001n, slot: 321 },
    ]);
    t.notify(t.last(), 2, null); // a closed account holds nothing
    expect(t.lamports().at(-1)).toEqual({ kind: 'lamports', index: 2, lamports: 0n, slot: 100 });
  });

  it('an unknown subscription id or an unsafe number changes nothing', () => {
    const t = setup(2);
    t.last().open();
    t.confirmAll(t.last());
    t.last().message({
      jsonrpc: '2.0',
      method: 'accountNotification',
      params: { result: { context: { slot: 1 }, value: { lamports: 5 } }, subscription: 1 },
    });
    t.notify(t.last(), 0, 2 ** 60); // loses digits as a JSON number
    expect(t.lamports()).toEqual([]);
  });

  it('wallets added later: exactly their subscriptions go out on the same socket', () => {
    const t = setup(3);
    t.last().open();
    const answered = t.confirmAll(t.last());
    t.stream.add([wallet(1), wallet(3), wallet(4)]); // 1 is already watched
    expect(t.subscribes(t.last()).map((s) => s.params[0])).toEqual([
      'Wallet0',
      'Wallet1',
      'Wallet2',
      'Wallet3',
      'Wallet4',
    ]);
    t.confirmAll(t.last(), answered);
    expect(t.stream.subscriptions()).toBe(5);
    expect(t.sockets).toHaveLength(1);
  });
});

describe('live balances: connection', () => {
  it('lost: polling, reconnect with backoff, every wallet subscribed again, live again', async () => {
    const t = setup(3);
    t.last().open();
    t.confirmAll(t.last());
    expect(t.stream.state()).toBe('live');
    t.last().fire('close');
    expect(t.stream.state()).toBe('polling');
    expect(t.stream.subscriptions()).toBe(0);
    await t.clock.runUntil(t.clock.now() + 1_000); // first backoff: 0.5–1 s
    expect(t.sockets).toHaveLength(2);
    t.last().open();
    expect(t.subscribes(t.last())).toHaveLength(3);
    t.confirmAll(t.last());
    expect(t.stream.state()).toBe('live');
    expect(t.feeds()).toEqual(['live', 'polling', 'live']);
  });

  it('a refused or unanswered subscription is a lost connection', async () => {
    const t = setup(2);
    t.last().open();
    const [first] = t.subscribes(t.last());
    t.last().message({ jsonrpc: '2.0', id: first?.id, error: { code: -32602 } });
    expect(t.last().closed).toBe(true);
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(t.sockets).toHaveLength(2);
    t.last().open(); // the server never answers
    await t.clock.runUntil(t.clock.now() + SUBSCRIBE_TIMEOUT_MS);
    expect(t.last().closed).toBe(true);
    expect(t.stream.state()).toBe('polling');
  });

  it('keep-alive at least once a minute; no answer in 10 s means dead', async () => {
    const t = setup(1);
    const start = t.clock.now();
    t.last().open();
    t.confirmAll(t.last());
    const first = t.last();
    const pings = () => first.sent.filter((m) => m.method === 'getHealth');
    // when each ping went out, on the test clock
    const sentAt: number[] = [];
    for (let ms = start; ms <= start + 3 * 60_000; ms += 1_000) {
      await t.clock.runUntil(ms);
      if (pings().length > sentAt.length) {
        sentAt.push(ms);
        first.reply(pings().at(-1)?.id); // the server answers
      }
    }
    expect(sentAt.length).toBeGreaterThanOrEqual(3);
    // the first within a minute of opening, then never more than a minute apart
    const gaps = [sentAt[0] ?? 0, ...sentAt.slice(1)].map(
      (at, i) => at - (i === 0 ? start : (sentAt[i - 1] ?? 0)),
    );
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
    expect(t.stream.state()).toBe('live');
    // no answer this time
    const before = pings().length;
    await t.clock.runUntil(t.clock.now() + KEEPALIVE_INTERVAL_MS + KEEPALIVE_TIMEOUT_MS);
    expect(pings().length).toBe(before + 1);
    expect(first.closed).toBe(true);
    expect(t.sockets).toHaveLength(2); // reconnecting
    expect(t.stream.state()).toBe('polling');
  });

  it('after stop, a late notification from the closed socket changes nothing', () => {
    const t = setup(2);
    const s = t.last();
    s.open();
    t.confirmAll(s);
    t.stream.stop();
    expect(s.closed).toBe(true);
    t.notify(s, 0, 7);
    expect(t.lamports()).toEqual([]);
    expect(t.stream.subscriptions()).toBe(0);
  });

  it('a notification from a socket already replaced changes nothing', async () => {
    const t = setup(1);
    const old = t.last();
    old.open();
    t.confirmAll(old);
    old.fire('close');
    await t.clock.runUntil(t.clock.now() + 1_000);
    t.last().open();
    t.confirmAll(t.last());
    t.notify(old, 0, 11);
    expect(t.lamports()).toEqual([]);
    t.notify(t.last(), 0, 12);
    expect(t.lamports().map((e) => e.lamports)).toEqual([12n]);
  });

  it('no event carries the URL or the key', async () => {
    const t = setup(2);
    t.last().open();
    t.confirmAll(t.last());
    t.notify(t.last(), 0, 1);
    t.last().fire('error', { message: `failed ${URL}` });
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(
      JSON.stringify(t.events, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/streamSecretKey123|helius-rpc/);
  });
});
