/**
 * Mode B in the vault worker (BUNNDLY-34, D-038): arm → a real pump.fun log → the first
 * `/order` for its mint with no wait for the RPC; reactionMs in the event and in the log;
 * one-shot and continuous; auto-lock; validation; DRY-RUN. Real vault and signing, fake
 * socket, fake Jupiter, RPC mock that answers after 1 s.
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { AppError, defaultFleetSettings, type FleetSettingsV1 } from '../../src/core/index.ts';
import { logEntry, type ExecutorEvent } from '../../src/executor/index.ts';
import type { JupiterClient } from '../../src/jupiter/index.ts';
import type { WatchEvent } from '../../src/watcher/watch.ts';
import type { VaultStatus, WorkerEvent } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';
import { launch, signatureOf, withBlockTime, withMint } from '../helpers/launch-fixtures.ts';
import { buildTransaction } from '../helpers/tx-fakes.ts';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const HELIUS_KEY = 'heliusWatchKey';
const N = launch(0);
const CREATOR = N.watched;
const MINT = N.expectedMint;
const MINT_2 = launch(1).expectedMint;
const SIG_2 = signatureOf(launch(1));
const SIG_3 = signatureOf(launch(2));
const RPC_DELAY_MS = 1_000;

/** As the real HTTP transport parses it: every integer is a bigint. */
function bigints(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(bigints);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigints(v)]));
  }
  return value;
}

interface Setup {
  readonly mode?: FleetSettingsV1['global']['mode'];
  readonly heliusKey?: boolean;
  /** Signature → transaction (json) the RPC returns. */
  readonly txs?: Record<string, unknown>;
  /** Real timers instead of the fake clock (latency test). */
  readonly realClock?: boolean;
  /** How long each `/order` takes (fake clock); 100 ms by default. */
  readonly orderMs?: number;
}

async function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const sleep = (ms: number): Promise<void> => (o.realClock ? Promise.resolve() : clock.sleep(ms));
  const rpcLog: { method: string; at: number }[] = [];
  const txs: Record<string, unknown> = { [signatureOf(N)]: N.tx, ...o.txs };
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'getMultipleAccounts':
        return {
          context: { slot: 1 },
          value: (params[0] as string[]).map(() => ({
            lamports: 1_000_000_000,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
            rentEpoch: 0,
            space: 0,
          })),
        };
      case 'getSignaturesForAddress': {
        const opts = params[1] as { until?: string };
        return opts.until === undefined
          ? [{ signature: signatureOf(launch(2)), slot: 1, err: null, memo: null, blockTime: 1 }]
          : [];
      }
      case 'getTransaction':
        return txs[params[0] as string] ?? null;
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const transport = (async (config: { payload: unknown }) => {
    const payload = config.payload as { id: unknown; method: string; params: unknown[] };
    rpcLog.push({ method: payload.method, at: clock.now() });
    await sleep(RPC_DELAY_MS); // a slow RPC: the detection must not wait for it
    return {
      jsonrpc: '2.0',
      id: payload.id,
      result: bigints(answer(payload.method, payload.params)),
    };
  }) as unknown as RpcTransport;

  const sockets: FakeSocket[] = [];
  const fake = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    ...(o.orderMs === undefined ? {} : { orderDelayMs: () => o.orderMs ?? 100 }),
  });
  /** Every `/order`: mint, fake-clock time and real time of the call. */
  const orders: { mint: string; at: number; perf: number }[] = [];
  const jupiter: JupiterClient = {
    getOrder: (request) => {
      orders.push({ mint: request.outputMint, at: clock.now(), perf: performance.now() });
      return fake.getOrder(request);
    },
    execute: (request) => fake.execute(request),
  };
  const h = createVaultHandler({
    chain: { createTransport: () => transport, sleep: () => Promise.resolve() },
    net: {
      createWebSocket: (url) => {
        expect(url).toContain(HELIUS_KEY);
        const s = new FakeSocket(clock.now());
        sockets.push(s);
        return s;
      },
    },
    executor: o.realClock ? { jupiter } : { jupiter, clock },
    ...(o.realClock ? {} : { watch: { perfNow: () => clock.now() } }),
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: WorkerEvent[] = [];
  h.onEvent((e) => events.push(e));
  await h.handle({
    type: 'create',
    fleetName: 'Obserwacja',
    walletCount: 2,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  await h.handle({
    type: 'saveSettings',
    settings: {
      ...base,
      maxSpend: [
        { index: 0, lamports: 10_000_000n },
        { index: 1, lamports: 10_000_000n },
      ],
      global: { ...base.global, mode: o.mode ?? 'one-shot' },
    },
    ...(o.heliusKey === false ? {} : { apiKeys: { helius: HELIUS_KEY } }),
  });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  /** Arms (the balance read takes the RPC's 1 s) and opens the socket. */
  const arm = async (creator = CREATOR): Promise<void> => {
    const armed = h.handle({ type: 'arm', creator });
    if (!o.realClock) await clock.runUntil(clock.now() + RPC_DELAY_MS);
    await armed;
    await clock.settle();
    socket().connect();
    await clock.settle();
  };
  const watchEvents = <T extends WatchEvent['type']>(type: T) =>
    events.filter(
      (e): e is Extract<WatchEvent, { type: T }> => e.kind === 'watch' && e.type === type,
    );
  const runs = () =>
    events.filter((e): e is Extract<ExecutorEvent, { kind: 'run' }> => e.kind === 'run');
  return {
    clock,
    h,
    events,
    status,
    socket,
    sockets,
    arm,
    orders,
    fake,
    rpcLog,
    watchEvents,
    runs,
  };
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  const e: unknown = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).code).toBe(code);
}

describe('arm → real pump.fun log → buy', () => {
  it('the first /order goes out for the mint at once, while the RPC still takes 1 s', async () => {
    const t = await setup();
    await t.arm();
    expect(t.orders).toHaveLength(0); // no Jupiter before a detection
    const deliveredAt = t.clock.now();
    t.socket().message(N.message);
    await t.clock.settle();

    expect(t.orders[0]).toMatchObject({ mint: MINT, at: deliveredAt });
    // the transaction of the log was asked for, but its answer is still 1 s away
    const txCall = t.rpcLog.find((c) => c.method === 'getTransaction');
    expect(txCall?.at).toBe(deliveredAt);

    const detection = t.watchEvents('detection')[0]?.detection;
    expect(detection).toMatchObject({
      mint: MINT,
      source: 'pump.fun',
      path: 'log',
      signature: signatureOf(N),
      reactionMs: 0, // fake clock: no time passes between the log and the /order
    });
    expect(detection?.runId).toBe(t.runs()[0]?.runId);
    // in the operations log
    const entry = logEntry(t.watchEvents('detection')[0] as WatchEvent, {
      addressOf: () => null,
      decimals: null,
    });
    expect(entry).toMatchObject({
      event: 'watch',
      state: 'detection',
      mint: MINT,
      source: 'pump.fun',
      path: 'log',
      signature: signatureOf(N),
      reactionMs: 0,
    });
    // and in the status
    expect((await t.status()).watch?.detections[0]?.reactionMs).toBe(0);
    // no key or URL in anything that leaves the worker
    expect(
      JSON.stringify(t.events, (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v)),
    ).not.toContain(HELIUS_KEY);
  });

  it('real clock: from delivering the log to the /order call in the mock takes under 50 ms', async () => {
    const t = await setup({ realClock: true });
    await t.arm();
    // the default wiring gives the watcher a Unix-ms clock (block times are compared with it)
    const armedAt = Date.parse((await t.status()).watch?.armedAt ?? '');
    expect(Math.abs(armedAt - Date.now())).toBeLessThan(60_000);
    const start = performance.now();
    t.socket().message(N.message);
    await new Promise((r) => setTimeout(r, 0));
    const first = t.orders[0];
    expect(first?.mint).toBe(MINT);
    expect((first?.perf ?? Infinity) - start).toBeLessThan(50);
    const reaction = t.watchEvents('detection')[0]?.detection.reactionMs;
    expect(reaction).not.toBeNull();
    expect(reaction ?? Infinity).toBeLessThan(50);
    await t.h.handle({ type: 'disarm' });
    await t.h.handle({ type: 'stop' });
  });
});

describe('a transaction from before arming (second layer, review of PR #26)', () => {
  it('logged as stale, 0 buys, no /order', async () => {
    const old = withBlockTime(N.tx, Math.floor(T0 / 1000) - 3_600);
    const t = await setup({ txs: { [SIG_2]: old } });
    await t.arm();
    t.socket().notify(SIG_2); // no launch in the log: the slow path reads the old transaction
    await t.clock.runUntil(t.clock.now() + RPC_DELAY_MS + 50);
    const stale = t.watchEvents('stale');
    expect(stale.map((e) => e.detection.mint)).toEqual([MINT]);
    const entry = logEntry(stale[0] as WatchEvent, { addressOf: () => null, decimals: null });
    expect(entry).toMatchObject({ event: 'watch', state: 'stale', reason: 'STALE', mint: MINT });
    expect(entry.message).toMatch(/sprzed uzbrojenia/u);
    expect(t.runs()).toHaveLength(0);
    expect(t.orders).toHaveLength(0);
    expect((await t.status()).watch?.armed).toBe(true);
    await t.h.handle({ type: 'disarm' });
  });
});

describe('modes', () => {
  it('one-shot: after the detection the watcher is disarmed and the socket closed, the buy goes on', async () => {
    const t = await setup();
    await t.arm();
    t.socket().message(N.message);
    await t.clock.settle();
    const s = await t.status();
    expect(t.socket().closed).toBe(true);
    expect(s.watch?.armed).toBe(false);
    expect(s.buy).toMatchObject({ mint: MINT });
    expect(s.armed).toBe(true); // the buy keeps the vault armed
    await t.clock.runUntil(t.clock.now() + 30_000);
    expect(t.runs().map((r) => r.phase)).toEqual(['started', 'finished']);
    expect(t.sockets).toHaveLength(1);
  });

  it('continuous: a second launch waits for the running buy; the same mint twice is one buy', async () => {
    const t = await setup({
      mode: 'continuous',
      orderMs: 3_000, // the first buy still runs when the second launch is detected
      txs: { [SIG_2]: withMint(N.tx, MINT, MINT_2), [SIG_3]: N.tx },
    });
    await t.arm();
    t.socket().message(N.message);
    await t.clock.settle();
    expect(t.runs().filter((r) => r.phase === 'started')).toHaveLength(1);

    t.socket().notify(SIG_2); // another launch: slow path, 1 s
    t.socket().notify(SIG_3); // the first mint again
    await t.clock.runUntil(t.clock.now() + RPC_DELAY_MS + 50);
    expect(t.watchEvents('queued').map((e) => e.detection.mint)).toEqual([MINT_2]);
    expect((await t.status()).watch?.queued).toEqual([MINT_2]);

    await t.clock.runUntil(t.clock.now() + 60_000);
    const started = t.runs().filter((r) => r.phase === 'started');
    expect(started.map((r) => r.mint)).toEqual([MINT, MINT_2]);
    const finished = t.runs().filter((r) => r.phase === 'finished');
    // the second buy started only after the first one finished
    expect(started[1]?.at).toBeGreaterThanOrEqual(finished[0]?.at ?? Infinity);
    expect(new Set(t.orders.map((o) => o.mint))).toEqual(new Set([MINT, MINT_2]));
    expect((await t.status()).watch?.armed).toBe(true);
    await t.h.handle({ type: 'disarm' });
  });

  it('STOP stops the buy but leaves the watcher armed', async () => {
    const t = await setup({ mode: 'continuous' });
    await t.arm();
    t.socket().message(N.message);
    await t.clock.settle();
    await t.h.handle({ type: 'stop' });
    await t.clock.runUntil(t.clock.now() + 30_000);
    const s = await t.status();
    expect(s.buy).toBeNull();
    expect(s.watch?.armed).toBe(true);
    expect(t.socket().closed).toBe(false);
    await t.h.handle({ type: 'disarm' });
  });

  it('DRY-RUN: a detection never calls /execute', async () => {
    const t = await setup();
    await t.arm();
    t.socket().message(N.message);
    await t.clock.runUntil(t.clock.now() + 30_000);
    expect(t.runs().at(-1)).toMatchObject({ phase: 'finished', dryRun: true });
    expect(t.fake.calls.filter((c) => c.kind === 'order').length).toBeGreaterThan(0);
    expect(t.fake.calls.filter((c) => c.kind === 'execute')).toEqual([]);
  });
});

describe('auto-lock and lock', () => {
  it('armed: no auto-lock and no manual lock; disarm closes the socket and brings auto-lock back', async () => {
    const t = await setup({ mode: 'continuous' });
    await t.arm();
    await t.clock.runUntil(t.clock.now() + 120_000);
    expect(t.h.checkAutoLock()).toBe(false);
    expect((await t.status()).locked).toBe(false);
    await rejectsWith(t.h.handle({ type: 'lock' }), 'WATCH_ARMED');

    await t.h.handle({ type: 'disarm' });
    expect(t.socket().closed).toBe(true);
    expect((await t.status()).armed).toBe(false);
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(true);
    expect((await t.status()).locked).toBe(true);
  });

  it('reads balances before arming and every 30 s', async () => {
    const t = await setup({ mode: 'continuous' });
    const reads = () => t.rpcLog.filter((c) => c.method === 'getMultipleAccounts').length;
    await t.arm();
    expect(reads()).toBe(1);
    expect(t.sockets).toHaveLength(1); // the socket opened after the read
    expect(t.sockets[0]?.createdAt).toBeGreaterThanOrEqual(
      (t.rpcLog.find((c) => c.method === 'getMultipleAccounts')?.at ?? Infinity) + RPC_DELAY_MS,
    );
    await t.clock.runUntil(t.clock.now() + 30_000 + RPC_DELAY_MS);
    expect(reads()).toBe(2);
    await t.h.handle({ type: 'disarm' });
  });
});

describe('arm validation', () => {
  it('no Helius key → HELIUS_KEY_MISSING', async () => {
    const t = await setup({ heliusKey: false });
    await rejectsWith(t.h.handle({ type: 'arm', creator: CREATOR }), 'HELIUS_KEY_MISSING');
    expect(t.sockets).toHaveLength(0);
  });

  it.each([
    ['not base58', 'not-an-address!'],
    ['too short', '9WzDXwBbmkg8ZTbNMqUxvQ'],
    ['the SOL mint', SOL_MINT],
  ])('creator %s → INVALID_CREATOR_ADDRESS', async (_name, creator) => {
    const t = await setup();
    await rejectsWith(t.h.handle({ type: 'arm', creator }), 'INVALID_CREATOR_ADDRESS');
  });

  it('during a buy → BUY_RUNNING; twice → WATCH_ARMED', async () => {
    const t = await setup();
    const read = t.h.handle({ type: 'refreshBalances' });
    await t.clock.runUntil(t.clock.now() + RPC_DELAY_MS);
    await read;
    await t.h.handle({ type: 'startBuy', mint: MINT });
    await rejectsWith(t.h.handle({ type: 'arm', creator: CREATOR }), 'BUY_RUNNING');
    await t.clock.runUntil(t.clock.now() + 30_000);
    await t.arm();
    await rejectsWith(t.h.handle({ type: 'arm', creator: CREATOR }), 'WATCH_ARMED');
    await t.h.handle({ type: 'disarm' });
  });

  it('no wallet ready → NO_WALLETS_TO_BUY', async () => {
    const t = await setup();
    const s = await t.status();
    const settings = s.info?.settings;
    if (!settings) throw new Error('no settings');
    await t.h.handle({ type: 'saveSettings', settings: { ...settings, maxSpend: [] } });
    await rejectsWith(t.h.handle({ type: 'arm', creator: CREATOR }), 'NO_WALLETS_TO_BUY');
  });
});
