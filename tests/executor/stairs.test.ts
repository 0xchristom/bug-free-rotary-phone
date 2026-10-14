/**
 * Stairs mode of the executor (BUNNDLY-61): steps of `perStep` wallets at absolute times,
 * pause and resume, STOP, retries, the limiter. Fake Jupiter and clock; the expected times
 * are written by hand from the task's acceptance criteria.
 */
import { describe, expect, it } from 'vitest';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';
import {
  ExecuteLimiter,
  OrderLimiter,
  startRun,
  type ExecutorEvent,
  type ExecutorWallet,
  type OrderSigner,
  type RunEvent,
  type RunSummary,
  type StairsOptions,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeJupiter, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 1_000_000_000n;
const S = 1_000;

const signer: OrderSigner = (_index, _request, order) =>
  Promise.resolve(
    order.transaction === null
      ? { ok: false, problem: 'NO_TRANSACTION' }
      : { ok: true, signedTransaction: `signed-${order.requestId}`, signature: null },
  );

const taker = (i: number): string => `Wallet${String(i).padStart(3, '0')}`;

function wallets(n: number): ExecutorWallet[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    address: taker(i),
    maxSpend: 10_000_000n,
    balance: SOL,
  }));
}

interface Setup {
  readonly n: number;
  readonly stairs?: StairsOptions;
  readonly walletList?: ExecutorWallet[];
  readonly script?: FakeJupiterScript;
  readonly orderRpm?: number;
  readonly triggeredAt?: number;
}

function setup(o: Setup) {
  const clock = new FakeClock(true);
  const chain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, { chain, ...o.script });
  const orderRpm = o.orderRpm ?? JUPITER_PLAN_RPM.free;
  const events: ExecutorEvent[] = [];
  const run = startRun(
    {
      jupiter,
      orderLimiter: new OrderLimiter({ orderRpm, clock }),
      executeLimiter: new ExecuteLimiter({ plan: 'free', orderRpm, clock }),
      sign: signer,
      landing: chain.checker,
      clock,
      emit: (e) => events.push(e),
    },
    {
      runId: 1,
      mint: MINT,
      wallets: o.walletList ?? wallets(o.n),
      dryRun: false,
      maxAttempts: 3,
      minReserveLamports: 15_000_000n,
      priceCeilingPercent: 50,
      noRouteWindowMs: 20_000,
      noRouteBackoffMinMs: 500,
      noRouteBackoffMaxMs: 2_000,
      ...(o.stairs === undefined ? {} : { stairs: o.stairs }),
      ...(o.triggeredAt === undefined ? {} : { triggeredAt: o.triggeredAt }),
    },
  );
  let summary: RunSummary | null = null;
  void run.done.then((s) => {
    summary = s;
  });
  const finish = async (): Promise<RunSummary> => {
    await clock.runUntil();
    if (summary === null) throw new Error('run did not finish');
    return summary;
  };
  /** Start of each wallet's first `/order`, ms after T0. */
  const firstOrders = (): (number | undefined)[] =>
    Array.from(
      { length: o.n },
      (_, i) => jupiter.calls.find((c) => c.kind === 'order' && c.taker === taker(i))?.start,
    ).map((t) => (t === undefined ? undefined : t - T0));
  return { clock, jupiter, events, run, finish, firstOrders };
}

const walletEvents = (events: ExecutorEvent[]): WalletEvent[] =>
  events.filter((e): e is WalletEvent => e.kind === 'wallet');
const runEvents = (events: ExecutorEvent[]): RunEvent[] =>
  events.filter((e): e is RunEvent => e.kind === 'run');

describe('steps at absolute times', () => {
  it('5 wallets, every 10 s, 1 per step: first /order at 0, 10, 20, 30 and 40 s', async () => {
    const { finish, firstOrders } = setup({ n: 5, stairs: { intervalMs: 10 * S, perStep: 1 } });
    const s = await finish();
    expect(firstOrders()).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    expect(s.counts.CONFIRMED).toBe(5);
  });

  it('2 per step: the steps at 0, 10 and 20 s let in 2, 2 and 1 wallet', async () => {
    const { events, finish, firstOrders } = setup({
      n: 5,
      stairs: { intervalMs: 10 * S, perStep: 2 },
    });
    await finish();
    const queuedAt = walletEvents(events)
      .filter((e) => e.state === 'QUEUED')
      .map((e) => [e.index, e.at - T0]);
    expect(queuedAt).toEqual([
      [0, 0],
      [1, 0],
      [2, 10_000],
      [3, 10_000],
      [4, 20_000],
    ]);
    // Nobody asks before its step: wallet 1 waits for the first probe (100 ms), not more.
    expect(firstOrders()).toEqual([0, 100, 10_000, 10_000, 20_000]);
    const steps = runEvents(events).filter((e) => e.phase === 'step');
    expect(steps.map((e) => [e.at - T0, e.stairs?.step, e.stairs?.steps])).toEqual([
      [0, 1, 3],
      [10_000, 2, 3],
      [20_000, 3, 3],
    ]);
  });

  it('before its step a wallet is SCHEDULED with its time and sends nothing', async () => {
    const { clock, events, jupiter } = setup({
      n: 3,
      stairs: { intervalMs: 10 * S, perStep: 1 },
    });
    await clock.runUntil(T0 + 9_999);
    expect(jupiter.calls.filter((c) => c.taker !== taker(0))).toEqual([]);
    const scheduled = walletEvents(events).filter((e) => e.state === 'SCHEDULED');
    expect(
      scheduled.map((e) => [e.index, e.scheduledAt === undefined ? null : e.scheduledAt - T0]),
    ).toEqual([
      [1, 10_000],
      [2, 20_000],
    ]);
  });

  it('a step that takes 7 s does not delay the next one', async () => {
    const { finish, firstOrders } = setup({
      n: 3,
      stairs: { intervalMs: 10 * S, perStep: 1 },
      script: { orderDelayMs: (c) => (c.taker === taker(0) ? 7_000 : 100) },
    });
    await finish();
    expect(firstOrders()).toEqual([0, 10_000, 20_000]);
  });

  it('mode B: steps count from the detection', async () => {
    const { finish, firstOrders } = setup({
      n: 2,
      stairs: { intervalMs: 10 * S, perStep: 1 },
      triggeredAt: T0 - 3_000,
    });
    await finish();
    expect(firstOrders()).toEqual([0, 7_000]);
  });

  it('wallets skipped before /order take no step', async () => {
    const list = wallets(4).map((w) => (w.index === 1 ? { ...w, balance: null } : w));
    const { finish, firstOrders } = setup({
      n: 4,
      walletList: list,
      stairs: { intervalMs: 10 * S, perStep: 1 },
    });
    const s = await finish();
    expect(firstOrders()).toEqual([0, undefined, 10_000, 20_000]);
    expect(s.wallets[1]?.reason).toEqual({
      kind: 'SKIPPED',
      code: 'BALANCE_UNKNOWN',
      detail: null,
    });
  });
});

describe('pause and resume', () => {
  it('a pause at 12 s for 30 s: the third step starts at 50 s; nothing is asked meanwhile', async () => {
    const { clock, events, jupiter, run, finish, firstOrders } = setup({
      n: 5,
      stairs: { intervalMs: 10 * S, perStep: 1 },
      // Wallet 1's transaction is still in flight when the pause begins.
      script: { executeDelayMs: (c) => (c.taker === taker(1) ? 5_000 : 300) },
    });
    await clock.runUntil(T0 + 12_000);
    expect(run.pause()).toBe(true);
    await clock.runUntil(T0 + 42_000);
    expect(run.resume()).toBe(true);
    const s = await finish();

    expect(firstOrders()).toEqual([0, 10_000, 50_000, 60_000, 70_000]);
    const duringPause = jupiter.calls.filter(
      (c) => c.start >= T0 + 12_000 && c.start < T0 + 42_000,
    );
    expect(duringPause).toEqual([]);
    const inFlight = jupiter.calls.find((c) => c.kind === 'execute' && c.taker === taker(1));
    expect(inFlight?.end).toBeGreaterThan(T0 + 12_000); // it finished during the pause
    expect(s.counts.CONFIRMED).toBe(5);
    // The wallets left got their new times at the resume.
    const rescheduled = walletEvents(events).filter(
      (e) => e.state === 'SCHEDULED' && e.at === T0 + 42_000,
    );
    expect(rescheduled.map((e) => [e.index, (e.scheduledAt ?? 0) - T0])).toEqual([
      [2, 50_000],
      [3, 60_000],
      [4, 70_000],
    ]);
    const phases = runEvents(events).map((e) => e.phase);
    expect(phases.filter((p) => p === 'paused' || p === 'resumed')).toEqual(['paused', 'resumed']);
  });

  it('wallets already queued wait out the pause too', async () => {
    // Step 1 lets in 3 wallets; 1 and 2 wait in the queue behind the probe (100 ms).
    const { clock, run, finish, firstOrders } = setup({
      n: 4,
      stairs: { intervalMs: 10 * S, perStep: 3 },
    });
    await clock.runUntil(T0 + 50);
    expect(run.pause()).toBe(true);
    await clock.runUntil(T0 + 5_000);
    expect(run.resume()).toBe(true);
    await finish();
    // Paused for 4950 ms: step 2 moves from 10 000 to 14 950 ms.
    expect(firstOrders()).toEqual([0, 5_000, 5_000, 14_950]);
  });

  it('pause has nothing to do without Stairs or once every step has started', async () => {
    const immediate = setup({ n: 2 });
    expect(immediate.run.pause()).toBe(false);
    await immediate.finish();

    const stairs = setup({ n: 2, stairs: { intervalMs: 10 * S, perStep: 1 } });
    await stairs.clock.runUntil(T0 + 10_000);
    expect(stairs.run.pause()).toBe(false); // both steps have started
    expect(stairs.run.resume()).toBe(false);
    await stairs.finish();
  });
});

describe('retries, STOP and the limiter', () => {
  it('a failed attempt in step 1 goes back to the queue and moves no later step', async () => {
    const { finish, firstOrders, jupiter } = setup({
      n: 4,
      stairs: { intervalMs: 10 * S, perStep: 1 },
      script: {
        order: (c) => (c.taker === taker(0) && c.nth === 1 ? { fail: 'TIMEOUT' } : 'ok'),
      },
    });
    const s = await finish();
    expect(firstOrders()).toEqual([0, 10_000, 20_000, 30_000]);
    expect(jupiter.calls.filter((c) => c.kind === 'order' && c.taker === taker(0))).toHaveLength(2);
    expect(s.counts.CONFIRMED).toBe(4);
  });

  it('STOP at 15 s: the wallets of steps 3 to 5 are skipped as Stopped and ask nothing', async () => {
    const { clock, jupiter, run, finish } = setup({
      n: 5,
      stairs: { intervalMs: 10 * S, perStep: 1 },
    });
    await clock.runUntil(T0 + 15_000);
    run.stop();
    const s = await finish();
    for (const i of [2, 3, 4]) {
      expect(s.wallets[i]?.reason).toEqual({ kind: 'SKIPPED', code: 'STOPPED', detail: null });
      expect(jupiter.calls.filter((c) => c.taker === taker(i))).toEqual([]);
    }
    expect(s.counts.CONFIRMED).toBe(2);
  });

  it('every 1 s with 10 per step at 60 /order per minute: no 60 s window above 54', async () => {
    const { finish, jupiter } = setup({
      n: 100,
      orderRpm: 60,
      stairs: { intervalMs: 1 * S, perStep: 10 },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(100);
    const starts = jupiter.calls.filter((c) => c.kind === 'order').map((c) => c.start);
    let worst = 0;
    for (const t of starts) {
      worst = Math.max(worst, starts.filter((u) => u >= t && u < t + 60_000).length);
    }
    expect(worst).toBe(54); // 90% of 60 per minute (D-028), the whole budget at the start
  });
});

describe('parameters out of range', () => {
  it('the run refuses them before any /order', () => {
    const bad = [
      { intervalMs: 999, perStep: 1 },
      { intervalMs: 24 * 60 * 60 * S + 1, perStep: 1 },
      { intervalMs: 1_500.5, perStep: 1 },
      { intervalMs: 10 * S, perStep: 0 },
      { intervalMs: 10 * S, perStep: 1.5 },
    ];
    for (const stairs of bad) {
      expect(() => setup({ n: 2, stairs }), JSON.stringify(stairs)).toThrow(RangeError);
    }
    for (const intervalMs of [1 * S, 24 * 60 * 60 * S]) {
      expect(() => setup({ n: 2, stairs: { intervalMs, perStep: 1 } })).not.toThrow();
    }
  });
});

describe('Immediate stays as it was', () => {
  it('no step, no SCHEDULED; first /order: the probe at 0, the other wallets at 100 ms', async () => {
    const { events, finish, firstOrders } = setup({ n: 5 });
    await finish();
    expect(firstOrders()).toEqual([0, 100, 100, 100, 100]);
    expect(walletEvents(events).some((e) => e.state === 'SCHEDULED')).toBe(false);
    expect(runEvents(events).every((e) => e.stairs === undefined)).toBe(true);
    expect(runEvents(events).map((e) => e.phase)).toEqual(['started', 'finished']);
  });
});
