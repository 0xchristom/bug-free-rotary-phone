/**
 * Mode B controller (BUNNDLY-34, D-038): detection → buy, one-shot and continuous, the
 * FIFO queue with dedup by mint, disarm, reactionMs and the balance refresh. Real
 * pump.fun notifications and transactions from mainnet; fake socket, RPC and clock.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { BuyMode } from '../../src/core/settings.ts';
import {
  BALANCE_REFRESH_MS,
  startWatch,
  type BuyTrigger,
  type WatchEvent,
} from '../../src/watcher/watch.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { launch, signatureOf, withBlockTime, withMint } from '../helpers/launch-fixtures.ts';

const URL = 'wss://mainnet.helius-rpc.com/?api-key=watchSecretKey123';
const N = launch(0);
const CREATOR = N.watched;
const MINT = N.expectedMint;
/** A second launch by the same creator: the real transaction with another mint. */
const MINT_2 = launch(1).expectedMint;
const SIG_2 = signatureOf(launch(1));
const SIG_3 = signatureOf(launch(2));

interface Setup {
  readonly mode?: BuyMode;
  /** Signature → `getTransaction` answer. */
  readonly txs?: Record<string, unknown>;
  /** Signatures of the creator after the baseline (the gap a catch-up reads). */
  readonly gap?: string[];
  readonly startBuy?: (trigger: BuyTrigger) => number;
}

function setup(o: Setup = {}) {
  const clock = new FakeClock(true);
  const sockets: FakeSocket[] = [];
  const events: WatchEvent[] = [];
  const triggers: BuyTrigger[] = [];
  const rpcCalls: string[] = [];
  /** `getTransaction` calls made before each buy started. */
  const rpcBeforeBuy: number[] = [];
  let perf = 1_000;
  let buying = false;
  let refreshes = 0;
  let nextRun = 1;
  const txs: Record<string, unknown> = { [signatureOf(N)]: N.tx, ...o.txs };
  const watch = startWatch(
    {
      createWebSocket: (url) => {
        expect(url).toBe(URL);
        const s = new FakeSocket(clock.now());
        sockets.push(s);
        return s;
      },
      signatures: (q) => {
        rpcCalls.push('getSignaturesForAddress');
        // the creator's newest signature at arming; nothing new since (no gap to catch up)
        return Promise.resolve(
          q.until === undefined
            ? [{ signature: 'Baseline', err: null, blockTime: null }]
            : (o.gap ?? []).map((signature) => ({ signature, err: null, blockTime: null })),
        );
      },
      getTransaction: (sig) => {
        rpcCalls.push(`getTransaction ${sig}`);
        return Promise.resolve(txs[sig] ?? null);
      },
      clock,
      perfNow: () => perf,
      random: () => 1,
      refreshBalances: () => {
        refreshes += 1;
        return Promise.resolve();
      },
      isBuying: () => buying,
      startBuy: (trigger) => {
        // a buy starts: from now on the vault says it is buying
        triggers.push(trigger);
        rpcBeforeBuy.push(rpcCalls.filter((c) => c.startsWith('getTransaction')).length);
        const id = o.startBuy?.(trigger) ?? nextRun++;
        buying = true;
        return id;
      },
      emit: (e) => events.push(e),
    },
    { url: URL, creator: CREATOR, mode: o.mode ?? 'one-shot' },
  );
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  const connect = async (): Promise<void> => {
    await clock.settle();
    socket().connect();
    await clock.settle();
  };
  const types = () => events.map((e) => e.type);
  const of = <T extends WatchEvent['type']>(type: T) =>
    events.filter((e): e is Extract<WatchEvent, { type: T }> => e.type === type);
  return {
    clock,
    watch,
    sockets,
    socket,
    connect,
    events,
    types,
    of,
    triggers,
    rpcCalls,
    rpcBeforeBuy,
    setPerf: (v: number) => {
      perf = v;
    },
    setBuying: (v: boolean) => {
      buying = v;
    },
    endBuy: () => {
      buying = false;
      watch.buyFinished();
    },
    refreshes: () => refreshes,
  };
}

describe('one-shot (default)', () => {
  it('a real pump.fun log starts the buy before any RPC, then disarms and closes the socket', async () => {
    const t = setup();
    await t.connect();
    t.setPerf(5_000); // the stream stamps the log with this
    t.socket().message(N.message);
    expect(t.triggers.map((x) => x.mint)).toEqual([MINT]);
    expect(t.rpcBeforeBuy).toEqual([0]); // the slow path starts only after the buy
    expect(t.socket().closed).toBe(true);
    expect(t.of('disarmed')).toMatchObject([{ reason: 'one-shot' }]);
    expect(t.watch.status().armed).toBe(false);

    // the first /order 12 ms after the log: the detection goes out with reactionMs
    t.setPerf(5_012);
    t.triggers[0]?.onFirstOrder();
    t.triggers[0]?.onFirstOrder(); // later ones change nothing
    const detections = t.of('detection');
    expect(detections).toHaveLength(1);
    expect(detections[0]?.detection).toMatchObject({
      mint: MINT,
      source: 'pump.fun',
      path: 'log',
      signature: signatureOf(N),
      runId: 1,
      reactionMs: 12,
      problem: null,
    });
    // the slow path still verifies the log
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(t.of('verified')).toMatchObject([{ mint: MINT, match: true }]);
    expect(t.watch.status().detections[0]?.verified).toBe(true);
    // one-shot: nothing more is detected
    expect(t.sockets).toHaveLength(1);
    expect(t.watch.active()).toBe(false);
  });

  it('a mode A buy is running: the detection waits for it, the socket closes at once', async () => {
    const t = setup();
    await t.connect();
    t.setBuying(true);
    t.socket().message(N.message);
    expect(t.triggers).toHaveLength(0);
    expect(t.socket().closed).toBe(true);
    expect(t.watch.status()).toMatchObject({ armed: false, queued: [MINT] });
    expect(t.watch.active()).toBe(true); // a detection still waits: the vault stays armed
    t.endBuy();
    expect(t.triggers.map((x) => x.mint)).toEqual([MINT]);
    expect(t.watch.active()).toBe(false);
  });
});

describe('continuous', () => {
  it('a second launch during the buy waits in the queue; the same mint again buys nothing', async () => {
    const t = setup({
      mode: 'continuous',
      txs: { [SIG_2]: withMint(N.tx, MINT, MINT_2), [SIG_3]: N.tx },
    });
    await t.connect();
    t.socket().message(N.message);
    expect(t.triggers.map((x) => x.mint)).toEqual([MINT]);
    expect(t.socket().closed).toBe(false);

    // a second launch (slow path) while the first buy runs
    t.socket().notify(SIG_2);
    // and another transaction of the first mint
    t.socket().notify(SIG_3);
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(t.triggers).toHaveLength(1);
    expect(t.of('queued').map((e) => e.detection.mint)).toEqual([MINT_2]);
    expect(t.watch.status().queued).toEqual([MINT_2]);

    t.endBuy();
    expect(t.triggers.map((x) => x.mint)).toEqual([MINT, MINT_2]);
    expect(t.triggers[1]?.detectedAt).toBe(t.of('queued')[0]?.detection.detectedAt);
    expect(t.watch.status().queued).toEqual([]);
    expect(t.watch.status().armed).toBe(true);
    // the queued detection counts from its log, wait included
    expect(t.of('queued')[0]?.detection.path).toBe('transaction');
  });

  it('disarm closes the socket and empties the queue; the running buy is not touched', async () => {
    const t = setup({ mode: 'continuous', txs: { [SIG_2]: withMint(N.tx, MINT, MINT_2) } });
    await t.connect();
    t.socket().message(N.message);
    t.socket().notify(SIG_2);
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(t.watch.status().queued).toEqual([MINT_2]);

    t.watch.disarm();
    expect(t.socket().closed).toBe(true);
    expect(t.watch.status().queued).toEqual([]);
    expect(t.watch.active()).toBe(false);
    expect(t.of('disarmed')).toMatchObject([{ reason: 'user' }]);
    expect(t.of('detection').map((e) => [e.detection.mint, e.detection.problem])).toEqual([
      [MINT_2, 'DISARMED'],
    ]);
    // the buy ends: nothing else starts
    t.endBuy();
    expect(t.triggers).toHaveLength(1);
    // no more reconnects
    await t.clock.runUntil(t.clock.now() + 60_000);
    expect(t.sockets).toHaveLength(1);
  });
});

describe('transactions from before arming (second layer, review of PR #26)', () => {
  it('catch-up: a launch an hour before arming is logged as stale and never bought', async () => {
    const old = withBlockTime(N.tx, Math.floor(T0 / 1000) - 3_600);
    const t = setup({ gap: [signatureOf(N)], txs: { [signatureOf(N)]: old } });
    await t.connect();
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(t.of('stale').map((e) => [e.detection.mint, e.detection.path])).toEqual([
      [MINT, 'catch-up'],
    ]);
    expect(t.of('stale')[0]?.detection.problem).toBe('STALE');
    expect(t.triggers).toHaveLength(0);
    // one-shot stays armed: a stale detection is not the launch it waits for
    expect(t.watch.status().armed).toBe(true);
    expect(t.socket().closed).toBe(false);
  });

  it('within 60 s before arming the launch still counts', async () => {
    const recent = withBlockTime(N.tx, Math.floor(T0 / 1000) - 30);
    const t = setup({ gap: [signatureOf(N)], txs: { [signatureOf(N)]: recent } });
    await t.connect();
    await t.clock.runUntil(t.clock.now() + 1_000);
    expect(t.of('stale')).toHaveLength(0);
    expect(t.triggers.map((x) => x.mint)).toEqual([MINT]);
  });
});

describe('buys that send no /order', () => {
  it('the buy cannot start: the detection carries the error code', async () => {
    const t = setup({
      startBuy: () => {
        throw new AppError('NO_WALLETS_TO_BUY');
      },
    });
    await t.connect();
    t.socket().message(N.message);
    expect(t.of('detection')[0]?.detection).toMatchObject({
      mint: MINT,
      runId: null,
      reactionMs: null,
      problem: 'NO_WALLETS_TO_BUY',
    });
  });

  it('the buy ends before its first /order (STOP): announced with reactionMs null', async () => {
    const t = setup();
    await t.connect();
    t.socket().message(N.message);
    expect(t.of('detection')).toHaveLength(0);
    t.endBuy();
    expect(t.of('detection')[0]?.detection).toMatchObject({ runId: 1, reactionMs: null });
  });
});

describe('balances and the socket', () => {
  it('reads balances every 30 s while armed, not after disarm', async () => {
    const t = setup({ mode: 'continuous' });
    await t.connect();
    expect(t.refreshes()).toBe(0); // the vault read them just before arming
    await t.clock.runUntil(t.clock.now() + BALANCE_REFRESH_MS);
    expect(t.refreshes()).toBe(1);
    await t.clock.runUntil(t.clock.now() + BALANCE_REFRESH_MS);
    expect(t.refreshes()).toBe(2);
    t.watch.disarm();
    await t.clock.runUntil(t.clock.now() + 3 * BALANCE_REFRESH_MS);
    expect(t.refreshes()).toBe(2);
  });

  it('the status has the time of the last message, also keep-alive answers', async () => {
    const t = setup({ mode: 'continuous' });
    await t.connect();
    await t.clock.runUntil(t.clock.now() + 30_000); // keep-alive sent
    const ping = t.socket().sent.at(-1);
    expect(ping?.method).toBe('getHealth');
    t.socket().reply(ping?.id);
    expect(t.watch.status().lastMessageAt).toBe(t.clock.now());
    t.watch.disarm();
    expect(t.watch.status().lastMessageAt).toBe(t.clock.now()); // kept after disarm
  });

  it('connection states go out without the URL', async () => {
    const t = setup();
    await t.connect();
    expect(t.of('connection').map((e) => e.status)).toEqual(['connecting', 'connected']);
    expect(JSON.stringify(t.events)).not.toContain('watchSecretKey123');
    expect(JSON.stringify(t.watch.status())).not.toContain('watchSecretKey123');
  });
});
