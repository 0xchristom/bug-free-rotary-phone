/** Jupiter rate limiters (BUNNDLY-20) with a fake clock. SPEC 7: no window over budget. */
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MAX_MS,
  ExecuteLimiter,
  OrderLimiter,
  WindowLimiter,
  executeBudget,
  orderBudget,
} from '../../src/executor/index.ts';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';

import { FakeClock, T0 } from '../helpers/fake-clock.ts';

/** Starts `count` calls at once; returns the time (ms after T0) each one was granted. */
function startAll(acquire: () => Promise<boolean>, clock: FakeClock, count: number) {
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    void acquire().then((ok) => {
      if (ok) starts.push(clock.now() - T0);
    });
  }
  return starts;
}

function maxInWindow(starts: readonly number[], windowMs: number): number {
  let max = 0;
  for (const s of starts) {
    const n = starts.filter((x) => x >= s && x < s + windowMs).length;
    max = Math.max(max, n);
  }
  return max;
}

describe('budgets', () => {
  it('/order: 90% of the plan per minute', () => {
    expect(orderBudget(JUPITER_PLAN_RPM.keyless)).toBe(27);
    expect(orderBudget(JUPITER_PLAN_RPM.free)).toBe(54);
    expect(orderBudget(JUPITER_PLAN_RPM.developer)).toBe(540);
    expect(orderBudget(JUPITER_PLAN_RPM.launch)).toBe(2700);
    expect(orderBudget(JUPITER_PLAN_RPM.pro)).toBe(8100);
    expect(orderBudget(100)).toBe(90); // custom plan: 90% of orderRpm
    expect(orderBudget(1)).toBe(1);
  });

  it('/execute: 90% of its own pool per second', () => {
    expect(executeBudget('keyless', 30)).toBe(18);
    expect(executeBudget('free', 60)).toBe(45);
    for (const plan of ['developer', 'launch', 'pro'] as const) {
      expect(executeBudget(plan, JUPITER_PLAN_RPM[plan])).toBe(90);
    }
    expect(executeBudget('custom', 30)).toBe(18);
    expect(executeBudget('custom', 60)).toBe(45);
    expect(executeBudget('custom', 120)).toBe(90);
  });
});

describe('/order window budget (SPEC 7: no 429 with the right plan)', () => {
  it.each([
    ['keyless', 30],
    ['keyless', 100],
    ['free', 30],
    ['free', 100],
  ] as const)('%s plan, %i wallets: burst at start, never over budget in 60 s', async (plan, n) => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: JUPITER_PLAN_RPM[plan], clock });
    const budget = limiter.budget;
    const starts = startAll(() => limiter.acquire(), clock, n);
    await clock.runUntil();
    expect(starts).toHaveLength(n);
    // the first min(budget, N) go out at once
    expect(starts.filter((s) => s === 0)).toHaveLength(Math.min(budget, n));
    expect(maxInWindow(starts, 60_000)).toBeLessThanOrEqual(budget);
    // and as fast as the budget allows: the next batch exactly one window later
    if (n > budget) expect(starts[budget]).toBe(60_000);
  });

  it('even pace (emergency mode): one start every 60 s / budget', async () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 60, clock, steady: true });
    const starts = startAll(() => limiter.acquire(), clock, 5);
    await clock.runUntil();
    const gap = 60_000 / 54;
    expect(starts.map((s) => Math.round(s))).toEqual(
      [0, 1, 2, 3, 4].map((i) => Math.round(i * gap)),
    );
  });
});

describe('correction from headers and 429', () => {
  it('429 with x-ratelimit-reset: nothing starts before the reset', async () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 60, clock });
    expect(await limiter.acquire()).toBe(true);
    const resetSec = Math.floor(T0 / 1000) + 7;
    limiter.report({ httpStatus: 429, rateLimit: { remaining: -1, current: 6, reset: resetSec } });
    const starts = startAll(() => limiter.acquire(), clock, 3);
    await clock.runUntil(resetSec * 1000 - 1);
    expect(starts).toEqual([]);
    await clock.runUntil();
    expect(starts).toEqual([7000, 7000, 7000]);
  });

  it('429 without a header: back off 1 s, 2 s, 4 s, 8 s, then at most 10 s', async () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 600, clock });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = clock.now();
      limiter.report({ httpStatus: 429, rateLimit: null });
      const granted = limiter.acquire();
      await clock.runUntil();
      expect(await granted).toBe(true);
      waits.push(clock.now() - before);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);

    // a success resets the backoff
    limiter.report({ httpStatus: 200, rateLimit: null });
    const before = clock.now();
    limiter.report({ httpStatus: 429, rateLimit: null });
    const granted = limiter.acquire();
    await clock.runUntil();
    expect(await granted).toBe(true);
    expect(clock.now() - before).toBe(1000);
  });

  it('remaining 0 on a 200 pauses until the reset; remaining > 0 changes nothing', async () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 60, clock });
    limiter.report({
      httpStatus: 200,
      rateLimit: { remaining: 3, current: 2, reset: Math.floor(T0 / 1000) + 30 },
    });
    expect(limiter.snapshot().pausedUntil).toBe(0);
    limiter.report({
      httpStatus: 200,
      rateLimit: { remaining: 0, current: 5, reset: Math.floor(T0 / 1000) + 4 },
    });
    const starts = startAll(() => limiter.acquire(), clock, 2);
    await clock.runUntil(T0 + 3999);
    expect(starts).toEqual([]);
    await clock.runUntil();
    expect(starts).toEqual([4000, 4000]);
  });

  it('remaining 0 without a reset backs off; a reset in the past too', () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 60, clock });
    limiter.report({ httpStatus: 200, rateLimit: { remaining: 0, current: null, reset: null } });
    expect(limiter.snapshot().pausedUntil).toBe(T0 + 1000);
    limiter.report({
      httpStatus: 429,
      rateLimit: { remaining: -1, current: 1, reset: Math.floor(T0 / 1000) - 5 },
    });
    expect(limiter.snapshot().pausedUntil).toBe(T0 + 2000);
  });

  it('a reset far in the future is capped at 60 s', () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 60, clock });
    limiter.report({
      httpStatus: 429,
      rateLimit: { remaining: 0, current: 1, reset: Math.floor(T0 / 1000) + 3600 },
    });
    expect(limiter.snapshot().pausedUntil).toBe(T0 + 60_000);
  });

  it('missing headers never change the budget; after a pause the window still holds', async () => {
    const clock = new FakeClock();
    const limiter = new OrderLimiter({ orderRpm: 30, clock }); // budget 27
    const starts = startAll(() => limiter.acquire(), clock, 27);
    await clock.settle();
    expect(starts).toHaveLength(27);
    limiter.report({ httpStatus: 200, rateLimit: null });
    limiter.report({ httpStatus: null, rateLimit: null }); // timeout
    const more = startAll(() => limiter.acquire(), clock, 1);
    await clock.runUntil(T0 + 59_999);
    expect(more).toEqual([]);
    await clock.runUntil();
    expect(more).toEqual([60_000]);
  });
});

describe('aborting a wait (STOP)', () => {
  it('an aborted waiter resolves false and frees its place', async () => {
    const clock = new FakeClock();
    const limiter = new WindowLimiter({ budget: 1, windowMs: 1000, clock });
    expect(await limiter.acquire()).toBe(true);
    const stop = new AbortController();
    const waiting = limiter.acquire(stop.signal);
    const next = limiter.acquire();
    stop.abort();
    expect(await waiting).toBe(false);
    await clock.runUntil();
    expect(await next).toBe(true);
    expect(clock.now()).toBe(T0 + 1000);
    expect(await limiter.acquire(stop.signal)).toBe(false); // already aborted
  });
});

describe('/execute', () => {
  it('has its own per-second pool, independent of the /order budget', async () => {
    const clock = new FakeClock();
    const order = new OrderLimiter({ orderRpm: 60, clock });
    const execute = new ExecuteLimiter({ plan: 'free', orderRpm: 60, clock });
    // /order budget used up and paused
    startAll(() => order.acquire(), clock, 54);
    order.report({ httpStatus: 429, rateLimit: null });
    await clock.settle();
    expect(order.snapshot()).toMatchObject({ inWindow: 54 });

    const starts = startAll(() => execute.acquire(), clock, 100);
    await clock.runUntil();
    expect(starts.filter((s) => s === 0)).toHaveLength(45);
    expect(maxInWindow(starts, 1000)).toBeLessThanOrEqual(45);
    expect(starts).toHaveLength(100);
    // and /execute never used the /order window
    expect(order.snapshot().inWindow).toBeLessThanOrEqual(54);
  });
});
