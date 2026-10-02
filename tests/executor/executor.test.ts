/** Executor (BUNNDLY-21): queue, pipeline, states, DRY-RUN, STOP. Fake Jupiter and clock. */
import { describe, expect, it } from 'vitest';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';
import {
  ExecuteLimiter,
  IllegalTransitionError,
  OrderLimiter,
  TRANSITIONS,
  assertTransition,
  startRun,
  type ExecutorEvent,
  type ExecutorWallet,
  type OrderSigner,
  type RunSummary,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeJupiter, seeded, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 1_000_000_000n;

function wallets(n: number, balance: bigint | null = SOL): ExecutorWallet[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    address: `Wallet${String(i).padStart(3, '0')}`,
    maxSpend: 10_000_000n,
    balance,
  }));
}

const signer: OrderSigner = (_index, _request, order) =>
  Promise.resolve(
    order.transaction === null
      ? { ok: false, problem: 'NO_TRANSACTION' }
      : { ok: true, signedTransaction: `signed-${order.requestId}`, signature: null },
  );

interface Setup {
  readonly n?: number;
  readonly walletList?: ExecutorWallet[];
  readonly plan?: keyof typeof JUPITER_PLAN_RPM;
  readonly script?: FakeJupiterScript;
  readonly dryRun?: boolean;
  readonly maxAttempts?: number;
  readonly sign?: OrderSigner;
}

function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const jupiter = new FakeJupiter(clock, o.script);
  const plan = o.plan ?? 'free';
  const events: ExecutorEvent[] = [];
  const run = startRun(
    {
      jupiter,
      orderLimiter: new OrderLimiter({ orderRpm: JUPITER_PLAN_RPM[plan], clock }),
      executeLimiter: new ExecuteLimiter({ plan, orderRpm: JUPITER_PLAN_RPM[plan], clock }),
      sign: o.sign ?? signer,
      clock,
      emit: (e) => events.push(e),
    },
    {
      runId: 1,
      mint: MINT,
      wallets: o.walletList ?? wallets(o.n ?? 30),
      dryRun: o.dryRun ?? false,
      maxAttempts: o.maxAttempts ?? 3,
      minReserveLamports: 15_000_000n,
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
  return { clock, jupiter, events, run, finish };
}

const walletEvents = (events: ExecutorEvent[]): WalletEvent[] =>
  events.filter((e): e is WalletEvent => e.kind === 'wallet');

describe('state machine', () => {
  it('rejects transitions outside the table', () => {
    expect(() => {
      assertTransition('IDLE', 'CONFIRMED');
    }).toThrow(IllegalTransitionError);
    expect(() => {
      assertTransition('CONFIRMED', 'QUEUED');
    }).toThrow(IllegalTransitionError);
    expect(() => {
      assertTransition('SKIPPED', 'QUEUED');
    }).toThrow(IllegalTransitionError);
    expect(TRANSITIONS.CONFIRMED).toEqual([]);
  });
});

describe('live run with the fake Jupiter', () => {
  it('30 wallets: all CONFIRMED, each with one /order and one /execute', async () => {
    const { jupiter, events, finish } = setup({ n: 30 });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(30);
    expect(jupiter.executions()).toHaveLength(30);
    const confirmed = walletEvents(events).filter((e) => e.state === 'CONFIRMED');
    expect(confirmed).toHaveLength(30);
    expect(confirmed[0]?.result?.totalOutputAmount).toBe(1_180_000n);
    expect(confirmed[0]?.times.orderMs).toBe(100);
    expect(confirmed[0]?.times.executeMs).toBe(300);
    // every wallet went through the whole pipeline, in order
    const states = walletEvents(events)
      .filter((e) => e.index === 7)
      .map((e) => e.state);
    expect(states).toEqual(['QUEUED', 'QUOTING', 'SIGNING', 'SUBMITTED', 'CONFIRMED']);
  });

  it('pipeline: a wallet executes while others still wait for /order (Keyless, 30 wallets)', async () => {
    const { jupiter, finish } = setup({ n: 30, plan: 'keyless' }); // budget 27
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(30);
    const firstExecute = Math.min(...jupiter.executions().map((c) => c.start));
    const lateOrders = jupiter.calls
      .filter(
        (c) => c.kind === 'order' && ['Wallet027', 'Wallet028', 'Wallet029'].includes(c.taker),
      )
      .map((c) => c.start);
    expect(firstExecute - T0).toBe(100);
    expect(Math.min(...lateOrders) - T0).toBe(60_000);
    expect(firstExecute).toBeLessThan(Math.min(...lateOrders));
  });

  it('random slippage: a failed wallet goes to the end of the queue, everyone finishes', async () => {
    const random = seeded(7);
    const { jupiter, events, finish } = setup({
      n: 30,
      maxAttempts: 10,
      script: { execute: () => (random() < 0.3 ? { code: -1000 } : 'ok') },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(30);
    const retried = walletEvents(events).filter((e) => e.state === 'QUEUED' && e.attempt > 0);
    expect(retried.length).toBeGreaterThan(3);
    // a requeued wallet's next /order comes after the /order of every wallet queued before it
    const first = retried[0];
    if (!first) throw new Error('no retry');
    const taker = `Wallet${String(first.index).padStart(3, '0')}`;
    const secondOrder = jupiter.calls.filter((c) => c.kind === 'order' && c.taker === taker)[1];
    const firstRound = jupiter.calls.filter((c) => c.kind === 'order').slice(0, 30);
    expect(secondOrder?.start).toBeGreaterThanOrEqual(Math.max(...firstRound.map((c) => c.start)));
    expect(jupiter.maxOpenPerWallet).toBe(1);
  });

  it('never more than one call in flight per wallet, also with slow and failing calls', async () => {
    const random = seeded(11);
    const { jupiter, finish } = setup({
      n: 40,
      maxAttempts: 5,
      script: {
        orderDelayMs: () => Math.floor(random() * 2000),
        order: () => (random() < 0.2 ? { fail: 'SERVER_ERROR', httpStatus: 503 } : 'ok'),
        executeDelayMs: () => Math.floor(random() * 3000),
        execute: () => (random() < 0.2 ? { code: -2004 } : 'ok'),
      },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED + s.counts.FAILED).toBe(40);
    expect(jupiter.maxOpenPerWallet).toBe(1);
  });

  it('attempts are limited: after maxAttempts the wallet FAILS with the last reason', async () => {
    const { jupiter, events, finish } = setup({
      n: 2,
      maxAttempts: 3,
      script: { order: () => ({ fail: 'TIMEOUT' }) },
    });
    const s = await finish();
    expect(s.counts.FAILED).toBe(2);
    expect(jupiter.ordersOf('Wallet000')).toBe(3);
    const failed = walletEvents(events).find((e) => e.state === 'FAILED');
    expect(failed?.reason).toEqual({ kind: 'FAILED', code: 'MAX_ATTEMPTS', detail: 'TIMEOUT' });
  });

  it('429 on /order does not use an attempt', async () => {
    let calls = 0;
    const { jupiter, finish } = setup({
      n: 1,
      maxAttempts: 1,
      script: { order: () => (++calls <= 3 ? { fail: 'RATE_LIMITED', httpStatus: 429 } : 'ok') },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(jupiter.ordersOf('Wallet000')).toBe(4);
  });

  it('no answer from /execute is UNKNOWN (never retried here); a refused check FAILS', async () => {
    const { jupiter, events, finish } = setup({
      n: 2,
      script: { execute: () => ({ fail: 'TIMEOUT' }) },
      sign: (index, request, order) =>
        index === 1
          ? Promise.resolve({ ok: false, problem: 'TAKER_MISMATCH' })
          : signer(index, request, order),
    });
    const s = await finish();
    expect(s.counts.UNKNOWN).toBe(1);
    expect(s.counts.FAILED).toBe(1);
    expect(jupiter.executions()).toHaveLength(1);
    const reasons = walletEvents(events)
      .filter((e) => e.state === 'UNKNOWN' || e.state === 'FAILED')
      .map((e) => e.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        { kind: 'UNKNOWN', code: 'EXECUTE_NO_ANSWER', detail: 'TIMEOUT' },
        { kind: 'FAILED', code: 'CHECK_FAILED', detail: 'TAKER_MISMATCH' },
      ]),
    );
  });
});

describe('skips before and after /order', () => {
  it('too little SOL for max spend + reserve, or no balance read: SKIPPED without /order', async () => {
    const list = [
      { index: 0, address: 'Rich', maxSpend: 10_000_000n, balance: 25_000_000n }, // exactly enough
      { index: 1, address: 'Poor', maxSpend: 10_000_000n, balance: 24_999_999n },
      { index: 2, address: 'Unread', maxSpend: 10_000_000n, balance: null },
    ];
    const { jupiter, events, finish } = setup({ walletList: list });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(jupiter.ordersOf('Poor') + jupiter.ordersOf('Unread')).toBe(0);
    const skipped = walletEvents(events).filter((e) => e.state === 'SKIPPED');
    expect(skipped.map((e) => [e.index, e.reason?.code])).toEqual([
      [1, 'INSUFFICIENT_SOL'],
      [2, 'BALANCE_UNKNOWN'],
    ]);
  });

  it('/order without a transaction: insufficient funds and SOL for gas → SKIPPED with the reason', async () => {
    const { events, finish } = setup({
      n: 3,
      script: {
        order: (c) =>
          c.taker === 'Wallet000'
            ? { build: 'INSUFFICIENT_FUNDS' }
            : c.taker === 'Wallet001'
              ? { build: 'INSUFFICIENT_SOL_FOR_GAS', errorCode: 2 }
              : 'ok',
      },
    });
    const s = await finish();
    expect(s.counts.SKIPPED).toBe(2);
    const reasons = walletEvents(events)
      .filter((e) => e.state === 'SKIPPED')
      .map((e) => e.reason?.code)
      .sort();
    expect(reasons).toEqual(['INSUFFICIENT_FUNDS', 'INSUFFICIENT_SOL_FOR_GAS']);
  });
});

describe('DRY-RUN', () => {
  it('real /order, checks and signing, then SKIPPED (DRY_RUN) with quote and times; zero /execute', async () => {
    const { jupiter, events, finish } = setup({ n: 30, dryRun: true });
    const s = await finish();
    expect(s.counts.SKIPPED).toBe(30);
    expect(jupiter.executions()).toHaveLength(0);
    const done = walletEvents(events).filter((e) => e.state === 'SKIPPED');
    expect(done.every((e) => e.reason?.code === 'DRY_RUN')).toBe(true);
    expect(done[0]?.quote).toEqual({
      inAmount: 10_000_000n,
      outAmount: 1_000_000_000n,
      router: 'metis',
    });
    expect(done[0]?.times.orderMs).toBe(100);
    expect(done[0]?.times.signMs).toBe(0);
  });

  it('zero /execute on every path, also with random failures and retries', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = seeded(seed);
      const { jupiter, finish } = setup({
        n: 20,
        dryRun: true,
        maxAttempts: 4,
        script: {
          orderDelayMs: () => Math.floor(random() * 1500),
          order: () => {
            const r = random();
            if (r < 0.15) return { fail: 'TIMEOUT' };
            if (r < 0.25) return { fail: 'RATE_LIMITED', httpStatus: 429 };
            if (r < 0.3) return { build: 'OTHER', errorCode: 9 };
            if (r < 0.35) return { fail: 'NO_ROUTE', httpStatus: 400 };
            return 'ok';
          },
        },
      });
      await finish();
      expect(jupiter.executions()).toHaveLength(0);
    }
  });

  it('/order calls in DRY-RUN use the limiter budget like live ones', async () => {
    const { jupiter, finish } = setup({ n: 60, dryRun: true, plan: 'free' }); // budget 54
    await finish();
    const starts = jupiter.calls.filter((c) => c.kind === 'order').map((c) => c.start - T0);
    expect(starts.filter((t) => t === 0)).toHaveLength(54);
    expect(Math.min(...starts.filter((t) => t > 0))).toBe(60_000);
  });
});

describe('STOP', () => {
  it('empties the queue and starts no new /order; sent transactions finish', async () => {
    const { clock, jupiter, events, run, finish } = setup({ n: 40, plan: 'keyless' }); // 27 at once
    await clock.runUntil(T0 + 150); // all 27 quoted, executing
    run.stop();
    const stopAt = clock.now();
    const s = await finish();
    expect(jupiter.calls.filter((c) => c.kind === 'order' && c.start > stopAt)).toHaveLength(0);
    // 27 quoted at once; the Keyless /execute pool sends 18 in the first second. Those 18
    // finish; the 9 signed but still waiting for an /execute slot are not sent.
    expect(jupiter.executions()).toHaveLength(18);
    expect(s.counts.CONFIRMED).toBe(18);
    expect(s.counts.SKIPPED).toBe(22);
    const stopped = walletEvents(events).filter((e) => e.reason?.code === 'STOPPED');
    expect(stopped).toHaveLength(22);
    expect(events.flatMap((e) => (e.kind === 'run' ? [e.phase] : []))).toEqual([
      'started',
      'stopping',
      'finished',
    ]);
  });

  it('a wallet signed but not yet sent at STOP is not sent', async () => {
    const { clock, jupiter, run, finish } = setup({
      n: 1,
      sign: async (i, r, o) => {
        await clock.sleep(50);
        return signer(i, r, o);
      },
    });
    await clock.runUntil(T0 + 120); // /order done, signing
    run.stop();
    const s = await finish();
    expect(s.counts.SKIPPED).toBe(1);
    expect(jupiter.executions()).toHaveLength(0);
  });
});

describe('events', () => {
  it('carry no signed transaction', async () => {
    const { jupiter, events, finish } = setup({ n: 5 });
    await finish();
    const text = JSON.stringify(events, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const call of jupiter.executions()) {
      expect(call.signedTransaction).toMatch(/^signed-/u);
      expect(text).not.toContain(call.signedTransaction);
    }
    expect(text).not.toContain('signed-');
  });
});
