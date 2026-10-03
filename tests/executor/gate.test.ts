/**
 * Mint gate (BUNNDLY-38, D-035): HTTP 500 and "no route" for a fresh mint use no attempts,
 * one probe /order at a time, the rest wait without requests; a route opens the gate.
 * Fake Jupiter, fake chain, fake clock.
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
  type RunSummary,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeJupiter, type FakeCall, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function wallets(n: number): ExecutorWallet[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    address: `Wallet${String(i).padStart(3, '0')}`,
    maxSpend: 10_000_000n,
    balance: 1_000_000_000n,
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
  readonly script?: (clock: FakeClock) => FakeJupiterScript;
  readonly noRouteWindowMs?: number;
  readonly maxAttempts?: number;
  readonly dryRun?: boolean;
  readonly plan?: 'free' | 'keyless';
}

function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const chain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, { chain, ...o.script?.(clock) });
  const events: ExecutorEvent[] = [];
  const run = startRun(
    {
      jupiter,
      orderLimiter: new OrderLimiter({ orderRpm: JUPITER_PLAN_RPM[o.plan ?? 'free'], clock }),
      executeLimiter: new ExecuteLimiter({
        plan: o.plan ?? 'free',
        orderRpm: JUPITER_PLAN_RPM[o.plan ?? 'free'],
        clock,
      }),
      sign: signer,
      landing: chain.checker,
      clock,
      emit: (e) => events.push(e),
    },
    {
      runId: 1,
      mint: MINT,
      wallets: wallets(o.n ?? 30),
      dryRun: o.dryRun ?? false,
      maxAttempts: o.maxAttempts ?? 3,
      minReserveLamports: 15_000_000n,
      priceCeilingPercent: 50,
      noRouteWindowMs: o.noRouteWindowMs ?? 20_000,
      noRouteBackoffMinMs: 500,
      noRouteBackoffMaxMs: 2_000,
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
  const finals = (): WalletEvent[] =>
    events.filter(
      (e): e is WalletEvent =>
        e.kind === 'wallet' && ['CONFIRMED', 'FAILED', 'SKIPPED', 'UNKNOWN'].includes(e.state),
    );
  return { clock, jupiter, run, finish, finals, events };
}

const orders = (jupiter: FakeJupiter): FakeCall[] =>
  jupiter.calls.filter((c) => c.kind === 'order');

/** No two of these calls were in flight at the same time. */
function sequential(calls: readonly FakeCall[]): boolean {
  const sorted = [...calls].sort((a, b) => a.start - b.start);
  return sorted.every((c, i) => i === 0 || c.start >= (sorted[i - 1]?.end ?? Infinity));
}

describe('fresh mint: 500, then "no route", then a route (30 wallets)', () => {
  it('no attempts used, one probe at a time, then everyone buys', async () => {
    const { jupiter, finish, finals } = setup({
      script: (clock) => ({
        order: () =>
          clock.now() < T0 + 300
            ? { fail: 'SERVER_ERROR', httpStatus: 500 }
            : clock.now() < T0 + 2_300
              ? { fail: 'NO_ROUTE', httpStatus: 400 }
              : 'ok',
      }),
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(30);
    expect(finals().some((e) => e.reason?.code === 'MAX_ATTEMPTS')).toBe(false);
    expect(finals().every((e) => e.attempt === 1)).toBe(true);

    const all = orders(jupiter);
    const firstRoute = all.find(
      (c) => (c.end ?? 0) > T0 + 2_300 - 100 && c.start >= T0 + 2_300 - 100,
    );
    const opensAt = firstRoute?.end ?? Infinity;
    const probes = all.filter((c) => (c.end ?? 0) <= opensAt);
    // while the gate was closed: never more than one /order in flight
    expect(sequential(probes)).toBe(true);
    // the probes, then one /order for each of the other 29
    expect(all.length).toBeLessThanOrEqual(30 + probes.length);
    expect(all).toHaveLength(probes.length + 29);
    // backoff 500 ms → 1 s → 2 s between probes
    expect(probes.map((c) => c.start - T0)).toEqual(
      [0, 600, 1_700, 3_800].filter((t) => t < 2_300 + 2_000),
    );
  });

  it('constant 500: everyone FAILED (NO_ROUTE) after the window; only probes were sent', async () => {
    const { jupiter, finish, finals } = setup({
      script: () => ({ order: () => ({ fail: 'SERVER_ERROR', httpStatus: 500 }) }),
    });
    const s = await finish();
    expect(s.counts.FAILED).toBe(30);
    expect(finals().every((e) => e.reason?.code === 'NO_ROUTE')).toBe(true);
    expect(finals().every((e) => e.reason?.detail === 'SERVER_ERROR')).toBe(true);
    const all = orders(jupiter);
    expect(sequential(all)).toBe(true); // every /order was the probe
    expect(all.length).toBeLessThan(15); // ~20 s / 2 s, not 30 × retries
    // the end of the window: failed without one more request
    const lastFail = Math.max(...finals().map((e) => e.at));
    expect(lastFail - T0).toBeGreaterThanOrEqual(20_000 + 100);
    expect(Math.max(...all.map((c) => c.start))).toBeLessThan(lastFail);
  });

  it('STOP while the gate is closed: the waiting wallets are SKIPPED (STOPPED), no new /order', async () => {
    const { clock, jupiter, run, finish, finals } = setup({
      script: () => ({ order: () => ({ fail: 'NO_ROUTE', httpStatus: 400 }) }),
    });
    await clock.runUntil(T0 + 1_000); // two probes so far, the second in backoff
    const before = orders(jupiter).length;
    run.stop();
    const s = await finish();
    expect(s.counts.SKIPPED).toBe(30);
    expect(finals().every((e) => e.reason?.code === 'STOPPED')).toBe(true);
    expect(orders(jupiter)).toHaveLength(before);
  });

  it('a 500 after the gate opened closes it again with a fresh window from that moment', async () => {
    let calls = 0;
    const { jupiter, finish, finals } = setup({
      n: 5,
      noRouteWindowMs: 2_300,
      // the 2nd call (the probe at 600 ms) has a route; everything else is 500
      script: () => ({
        order: () => (++calls === 2 ? 'ok' : { fail: 'SERVER_ERROR', httpStatus: 500 }),
      }),
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(s.counts.FAILED).toBe(4);
    const failedAt = finals()
      .filter((e) => e.state === 'FAILED')
      .map((e) => e.at - T0);
    // re-closed at 800 ms (the 4 wallets' answers) → the window ends at 3 100 ms, not at
    // 2 400 ms as it would counted from the first "no route" (100 ms)
    expect(Math.min(...failedAt)).toBeGreaterThanOrEqual(800 + 2_300);
    // after the reopening the gate was closed again: the 4 wallets sent once together,
    // then only sequential probes
    const afterOpen = orders(jupiter).filter((c) => c.start >= T0 + 700);
    const burst = afterOpen.filter((c) => c.start === T0 + 700);
    expect(burst).toHaveLength(4);
    expect(sequential(afterOpen.filter((c) => c.start > T0 + 700))).toBe(true);
  });

  it('the route goes for good after opening: FAILED (NO_ROUTE) a window after the re-close, then silence', async () => {
    let calls = 0;
    const { jupiter, finish, finals } = setup({
      n: 5,
      // the first /order (the opening probe) has a route, then 500 for good
      script: () => ({
        order: () => (++calls === 1 ? 'ok' : { fail: 'SERVER_ERROR', httpStatus: 500 }),
      }),
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(s.counts.FAILED).toBe(4);
    expect(finals().every((e) => e.state !== 'FAILED' || e.reason?.code === 'NO_ROUTE')).toBe(true);
    // opened at 100 ms, the other 4 sent at 100 ms, all 500 at 200 ms: re-closed at 200 ms
    const windowEnd = T0 + 200 + 20_000;
    const failedAt = finals()
      .filter((e) => e.state === 'FAILED')
      .map((e) => e.at);
    expect(Math.min(...failedAt)).toBeGreaterThanOrEqual(windowEnd);
    expect(orders(jupiter).filter((c) => c.start >= windowEnd)).toHaveLength(0);
  });

  it('a probe still in flight when the window ends: everyone waiting fails, no new /order', async () => {
    const { jupiter, finish, finals } = setup({
      n: 5,
      noRouteWindowMs: 2_000,
      script: () => ({
        // the second probe (600 ms) answers only at 3 600 ms, after the window (100 + 2 000)
        orderDelayMs: (c) => (c.nth === 1 && c.taker === 'Wallet000' ? 100 : 3_000),
        order: () => ({ fail: 'SERVER_ERROR', httpStatus: 500 }),
      }),
    });
    const s = await finish();
    expect(s.counts.FAILED).toBe(5);
    expect(finals().every((e) => e.reason?.code === 'NO_ROUTE')).toBe(true);
    const starts = orders(jupiter).map((c) => c.start - T0);
    expect(starts).toEqual([0, 600]);
  });
});

describe('waiting for the limiter does not count as time without a route', () => {
  it('Keyless: a probe that waited ~60 s for its slot and gets one more 500 does not end the window', async () => {
    let calls = 0;
    const { jupiter, finish, finals } = setup({
      n: 30,
      plan: 'keyless', // 27 /order per 60 s
      // the opening probe has a route; the 26 sent right after it get 500 (re-close);
      // the next probe, sent only when the limiter frees a slot at 60 s, gets 500 too
      script: () => ({
        order: () => {
          calls += 1;
          return calls >= 2 && calls <= 28 ? { fail: 'SERVER_ERROR', httpStatus: 500 } : 'ok';
        },
      }),
    });
    const s = await finish();
    expect(finals().some((e) => e.reason?.code === 'NO_ROUTE')).toBe(false);
    expect(s.counts.CONFIRMED).toBe(30);
    const second = orders(jupiter)[27];
    expect((second?.start ?? 0) - T0).toBeGreaterThanOrEqual(60_000); // it did wait
  });
});

describe('other /order failures still use attempts', () => {
  it.each(['TIMEOUT', 'NETWORK'] as const)('%s: MAX_ATTEMPTS after 3 /order', async (fail) => {
    const { jupiter, finish, finals } = setup({
      n: 1,
      script: () => ({ order: () => ({ fail }) }),
    });
    const s = await finish();
    expect(s.counts.FAILED).toBe(1);
    expect(finals()[0]?.reason).toEqual({ kind: 'FAILED', code: 'MAX_ATTEMPTS', detail: fail });
    expect(orders(jupiter)).toHaveLength(3);
  });
});
