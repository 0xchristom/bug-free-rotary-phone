/**
 * Fleet simulation with invariants (BUNNDLY-23, formerly BUNNDLY-29): 50 and 100 wallets,
 * Keyless and Free, live and DRY-RUN, seeded random failures (delays, 429, 5xx, timeouts
 * after landing, "no route" for the first seconds, slippage, RFQ with an unknown
 * signature, STOP at a random moment). The fake chain is the truth the invariants use.
 *
 * `npm test` runs a fast set of seeds; `npm run test:sim` (`--mode sim`) the long one.
 */
import { describe, expect, it } from 'vitest';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';
import {
  ExecuteLimiter,
  FINAL_STATES,
  ORDER_WINDOW_MS,
  OrderLimiter,
  orderBudget,
  startRun,
  type ExecutorWallet,
  type OrderSigner,
  type RunSummary,
} from '../../src/executor/index.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import {
  FakeJupiter,
  seeded,
  type ExecuteOutcome,
  type OrderOutcome,
} from '../helpers/fake-jupiter.ts';

/** Vite's mode: `--mode sim` selects the long set (the test tsconfig has no vite types). */
const LONG =
  (import.meta as ImportMeta & { readonly env: { readonly MODE: string } }).env.MODE === 'sim';
const FIRST_SEED = 1;
const SEEDS = LONG ? 5_000 : 50;
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const signer: OrderSigner = (_index, _request, order) =>
  Promise.resolve(
    order.transaction === null
      ? { ok: false, problem: 'NO_TRANSACTION' }
      : {
          ok: true,
          signedTransaction: `signed-${order.requestId}`,
          signature: order.signatureFeePayer === order.taker ? `sig-${order.requestId}` : null,
        },
  );

export interface Scenario {
  readonly seed: number;
  readonly wallets: 50 | 100;
  readonly plan: 'keyless' | 'free';
  readonly dryRun: boolean;
  /** ms after the start, or null for no STOP. */
  readonly stopAt: number | null;
  readonly noRouteMs: number;
}

export function scenario(seed: number): Scenario {
  const random = seeded(seed * 7919);
  return {
    seed,
    wallets: random() < 0.5 ? 50 : 100,
    plan: random() < 0.5 ? 'keyless' : 'free',
    dryRun: random() < 0.25,
    stopAt: random() < 0.3 ? Math.floor(random() * 120_000) : null,
    noRouteMs: random() < 0.5 ? Math.floor(random() * 8_000) : 0,
  };
}

export interface SimResult {
  /** Broken invariants; empty when all hold. */
  readonly broken: string[];
  /** Final reason (or CONFIRMED) per wallet, counted: shows which paths ran. */
  readonly outcomes: Record<string, number>;
  readonly executes: number;
  readonly chainChecks: number;
  readonly landedWithError: number;
  /** Fake time the run took. */
  readonly durationMs: number;
}

/** Runs one scenario and checks the invariants against the fake chain. */
export async function simulate(s: Scenario): Promise<SimResult> {
  const random = seeded(s.seed);
  const clock = new FakeClock(true);
  const chain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, {
    chain,
    orderDelayMs: () => 50 + Math.floor(random() * 1_500),
    order: (): OrderOutcome => {
      if (clock.now() - T0 < s.noRouteMs) return { fail: 'NO_ROUTE', httpStatus: 400 };
      const r = random();
      if (r < 0.05) return { fail: 'RATE_LIMITED', httpStatus: 429 };
      if (r < 0.1) return { fail: 'SERVER_ERROR', httpStatus: 503 };
      if (r < 0.12) return { fail: 'TIMEOUT' };
      if (r < 0.14) return { build: 'OTHER', errorCode: 9 };
      if (r < 0.15) return { build: 'INSUFFICIENT_FUNDS' };
      return 'ok';
    },
    rfq: () => random() < 0.3,
    // the price drifts; now and then it spikes above the 50 % ceiling
    outAmount: (c) =>
      random() < 0.05
        ? (c.amount * 100n * 10n) / 18n
        : (c.amount * 100n * BigInt(900 + Math.floor(random() * 200))) / 1_000n,
    executeDelayMs: () => 200 + Math.floor(random() * 3_000),
    execute: (): ExecuteOutcome => {
      const r = random();
      const later = (p: number, ok = true, maxMs = 90_000) =>
        random() < p ? { lands: { ok, afterMs: Math.floor(random() * maxMs) } } : {};
      if (r < 0.55) return 'ok';
      if (r < 0.65) return { fail: 'TIMEOUT', ...later(0.7) };
      if (r < 0.7) return { fail: 'NETWORK' };
      if (r < 0.76) return { code: -1000, ...later(0.4, true, 60_000) };
      if (r < 0.8) return { code: -1001, ...later(0.5) };
      if (r < 0.82) return { code: -2000, ...later(0.3) };
      if (r < 0.84) return { code: -2001, ...later(0.5) };
      // Jupiter refused before sending: these never land
      if (r < 0.86) return { code: -2004 };
      if (r < 0.88) return { code: -1 };
      if (r < 0.89) return { code: -2003 };
      if (r < 0.93) return { code: 6001, lands: { ok: false } }; // slippage on the chain
      if (r < 0.95) return { fail: 'SERVER_ERROR', httpStatus: 502, ...later(0.5) };
      if (r < 0.96) return { code: -1003 };
      return 'ok';
    },
  });
  const wallets: ExecutorWallet[] = Array.from({ length: s.wallets }, (_, i) => ({
    index: i,
    address: `Wallet${String(i).padStart(3, '0')}`,
    maxSpend: 5_000_000n + BigInt(i) * 100_000n,
    // a few cannot afford max spend + reserve, a few were never read
    balance: i % 23 === 7 ? null : i % 19 === 5 ? 1_000_000n : 1_000_000_000n,
  }));
  const rpm = JUPITER_PLAN_RPM[s.plan];
  const run = startRun(
    {
      jupiter,
      orderLimiter: new OrderLimiter({ orderRpm: rpm, clock }),
      executeLimiter: new ExecuteLimiter({ plan: s.plan, orderRpm: rpm, clock }),
      sign: signer,
      landing: chain.checker,
      clock,
      emit: () => undefined,
    },
    {
      runId: s.seed,
      mint: MINT,
      wallets,
      dryRun: s.dryRun,
      maxAttempts: 3,
      minReserveLamports: 15_000_000n,
      priceCeilingPercent: 50,
      noRouteWindowMs: 20_000,
      noRouteBackoffMinMs: 500,
      noRouteBackoffMaxMs: 2_000,
    },
  );
  let summary: RunSummary | null = null;
  void run.done.then((r) => {
    summary = r;
  });
  let stoppedAt: number | null = null;
  if (s.stopAt !== null) {
    await clock.runUntil(T0 + s.stopAt);
    run.stop();
    stoppedAt = clock.now();
  }
  await clock.runUntil();

  const broken: string[] = [];
  const done = summary as RunSummary | null;
  if (done === null) {
    return {
      broken: ['the run did not finish'],
      outcomes: {},
      executes: 0,
      chainChecks: 0,
      landedWithError: 0,
      durationMs: 0,
    };
  }
  const outcomes: Record<string, number> = {};
  for (const w of done.wallets) {
    const key = w.reason === null ? w.state : `${w.state}:${w.reason.code}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  for (const w of done.wallets) {
    const taker = wallets[w.index]?.address ?? '';
    const maxSpend = wallets[w.index]?.maxSpend ?? 0n;
    if (!FINAL_STATES.has(w.state)) broken.push(`${taker}: not final (${w.state})`);
    if (w.state !== 'CONFIRMED' && w.reason === null) broken.push(`${taker}: no reason`);
    if (w.state === 'UNKNOWN') broken.push(`${taker}: UNKNOWN with a healthy chain`);
    const buys = chain.successfulBuys(taker);
    if (buys.length > 1) broken.push(`${taker}: ${String(buys.length)} buys`);
    const spent = buys.reduce((sum, b) => sum + b.spent, 0n);
    if (spent > maxSpend) broken.push(`${taker}: spent ${String(spent)} > ${String(maxSpend)}`);
    if ((w.state === 'CONFIRMED') !== (buys.length === 1)) {
      broken.push(`${taker}: ${w.state} but ${String(buys.length)} buys on the chain`);
    }
  }
  const starts = jupiter.calls
    .filter((c) => c.kind === 'order')
    .map((c) => c.start)
    .sort((a, b) => a - b);
  const budget = orderBudget(rpm);
  for (let i = 0; i + budget < starts.length; i++) {
    const a = starts[i] ?? 0;
    const b = starts[i + budget] ?? 0;
    if (b - a < ORDER_WINDOW_MS)
      broken.push(`more than ${String(budget)} /order in 60 s at ${String(a - T0)}`);
  }
  if (s.dryRun && jupiter.executions().length > 0) broken.push('/execute in DRY-RUN');
  if (stoppedAt !== null) {
    const stop = stoppedAt;
    const after = starts.filter((t) => t > stop);
    if (after.length > 0) broken.push(`${String(after.length)} /order after STOP`);
  }
  if (jupiter.maxOpenPerWallet > 1) broken.push('two calls in flight for one wallet');
  return {
    broken,
    outcomes,
    executes: jupiter.executions().length,
    chainChecks: chain.checks,
    landedWithError: chain.landed.filter((l) => !l.ok).length,
    durationMs: clock.now() - T0,
  };
}

describe(`fleet invariants (${String(SEEDS)} seeds${LONG ? ', long set' : ''})`, () => {
  const seeds = Array.from({ length: SEEDS }, (_, i) => FIRST_SEED + i);

  const results: SimResult[] = [];

  it.each(seeds)(
    'seed %i',
    async (seed) => {
      const s = scenario(seed);
      const result = await simulate(s);
      results.push(result);
      expect(result.broken, JSON.stringify(s)).toEqual([]);
    },
    60_000,
  );

  it('the runs went through every path (not a vacuous pass)', () => {
    expect(results).toHaveLength(SEEDS);
    const total: Record<string, number> = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.outcomes)) total[k] = (total[k] ?? 0) + v;
    }
    for (const key of [
      'CONFIRMED',
      'SKIPPED:DRY_RUN',
      'SKIPPED:STOPPED',
      'SKIPPED:PRICE_CEILING',
      'SKIPPED:INSUFFICIENT_SOL',
      'SKIPPED:BALANCE_UNKNOWN',
      'SKIPPED:INSUFFICIENT_FUNDS',
      'FAILED:MAX_ATTEMPTS',
      'FAILED:EXECUTE_FAILED',
    ]) {
      expect(total[key] ?? 0, key).toBeGreaterThan(0);
    }
    expect(results.reduce((n, r) => n + r.executes, 0)).toBeGreaterThan(SEEDS * 20);
    expect(results.reduce((n, r) => n + r.chainChecks, 0)).toBeGreaterThan(SEEDS * 10);
    expect(results.reduce((n, r) => n + r.landedWithError, 0)).toBeGreaterThan(0);
    // 100 Keyless wallets need several 60 s windows
    expect(Math.max(...results.map((r) => r.durationMs))).toBeGreaterThan(180_000);
  });

  it('the scenarios cover every mode', () => {
    const all = seeds.map(scenario);
    expect(new Set(all.map((s) => s.wallets))).toEqual(new Set([50, 100]));
    expect(new Set(all.map((s) => s.plan))).toEqual(new Set(['keyless', 'free']));
    expect(new Set(all.map((s) => s.dryRun))).toEqual(new Set([true, false]));
    expect(all.some((s) => s.stopAt !== null)).toBe(true);
    expect(all.some((s) => s.noRouteMs > 0)).toBe(true);
  });
});
