/**
 * Fleet simulation with invariants (BUNNDLY-23, formerly BUNNDLY-29): 50 and 100 wallets,
 * Keyless and Free, live and DRY-RUN, seeded random failures (delays, 429, 5xx, timeouts
 * after landing, "no route" for the first seconds, slippage, RFQ with an unknown
 * signature, STOP at a random moment). The fake chain is the truth the invariants use.
 * Wallet groups (BUNNDLY-68): two runs at once on the limiters of one plan, as the vault
 * runs them; STOP stops only the first.
 * Stairs (BUNNDLY-61): steps at fixed times, now and then a pause; no wallet asks before
 * its step and nothing is asked while the run is paused.
 * Direct route (BUNNDLY-48): the failures of the devnet Meteora DBC route instead of
 * Jupiter's (preflight refusal, a lost `sendTransaction` answer after the RPC took it, a
 * landed buy with an error, no RFQ) and DRY-RUN through `simulate`. Its sells (BUNNDLY-63)
 * add the curve moving below the minimum just before the send (`PRICE_MOVED`, not sent)
 * and too little SOL for the fees.
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
  type Side,
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
/** Sell runs (BUNNDLY-60), on top of the buy runs: their own seeds, the same failures. */
const SELL_SEEDS = LONG ? 2_000 : 20;
const FIRST_SELL_SEED = 100_001;
/** Two groups at once (BUNNDLY-68), on top of the runs above: their own seeds. */
const GROUP_SEEDS = LONG ? 1_000 : 10;
const FIRST_GROUP_SEED = 200_001;
/** Stairs runs (BUNNDLY-61), on top of the runs above: their own seeds. */
const STAIRS_SEEDS = LONG ? 1_000 : 10;
const FIRST_STAIRS_SEED = 300_001;
/** Direct-route runs (BUNNDLY-48), on top of the runs above: their own seeds. */
const DIRECT_SEEDS = LONG ? 1_000 : 10;
const FIRST_DIRECT_SEED = 400_001;
/** Direct-route sells (BUNNDLY-63): their own seeds. */
const DIRECT_SELL_SEEDS = LONG ? 1_000 : 10;
const FIRST_DIRECT_SELL_SEED = 500_001;
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** The second group's mint (any token mint other than MINT). */
const MINT_2 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  /** Fresh mint (D-035): HTTP 500 for this long, then "no route" for `noRouteMs`. */
  readonly serverErrorMs: number;
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
    serverErrorMs: random() < 0.5 ? Math.floor(random() * 600) : 0,
  };
}

/** Stairs of a run: a step every `intervalMs` with `perStep` wallets, maybe one pause. */
export interface StairsPlan {
  readonly intervalMs: number;
  readonly perStep: number;
  /** ms after the start and how long, or null for no pause. */
  readonly pause: { readonly at: number; readonly forMs: number } | null;
}

export function stairsPlan(seed: number): StairsPlan {
  const random = seeded(seed * 104_729);
  return {
    intervalMs: 1_000 + Math.floor(random() * 19_000),
    perStep: 1 + Math.floor(random() * 20),
    pause:
      random() < 0.6
        ? { at: Math.floor(random() * 60_000), forMs: 1_000 + Math.floor(random() * 60_000) }
        : null,
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
  /** Two groups: some 60 s window held the full budget with /order of both groups. */
  readonly sharedFullWindow: boolean;
  /** Stairs: the run really was paused for a while. */
  readonly paused: boolean;
  /** Direct route: `simulate` calls (DRY-RUN). */
  readonly simulations: number;
  /** Direct sells: executions refused because the curve moved (`PRICE_MOVED`). */
  readonly priceMoved: number;
}

/**
 * Runs one scenario and checks the invariants against the fake chain. For a sell,
 * `maxSpend` is the planned token amount and `spent` on the chain is the tokens sold.
 * `groups: 2`: the first half of the wallets buys MINT, the second half MINT_2, both runs
 * at once on one pair of limiters; STOP stops the first group only. `stairs`: one group
 * in steps, paused as the plan says.
 */
export async function simulate(
  s: Scenario,
  side: Side = 'buy',
  groups: 1 | 2 = 1,
  stairs: StairsPlan | null = null,
  route: 'jupiter' | 'direct' = 'jupiter',
): Promise<SimResult> {
  const selling = side === 'sell';
  const direct = route === 'direct';
  const random = seeded(s.seed);
  const clock = new FakeClock(true);
  const chain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, {
    chain,
    orderDelayMs: () => 50 + Math.floor(random() * 1_500),
    order: (): OrderOutcome => {
      const since = clock.now() - T0;
      if (since < s.serverErrorMs) return { fail: 'SERVER_ERROR', httpStatus: 500 };
      if (since < s.serverErrorMs + s.noRouteMs) return { fail: 'NO_ROUTE', httpStatus: 400 };
      const r = random();
      if (direct) {
        // The route's RPC read failed, or the balance does not cover the buy and its rent
        // (a sell: the fees and the wrapped SOL rent).
        if (r < 0.1) return { fail: 'NETWORK' };
        if (r < 0.12) return { build: selling ? 'INSUFFICIENT_SOL_FOR_GAS' : 'INSUFFICIENT_FUNDS' };
        return 'ok';
      }
      if (r < 0.05) return { fail: 'RATE_LIMITED', httpStatus: 429 };
      if (r < 0.1) return { fail: 'SERVER_ERROR', httpStatus: 503 };
      if (r < 0.12) return { fail: 'TIMEOUT' };
      if (r < 0.14) return { build: 'OTHER', errorCode: 9 };
      if (r < 0.15) return { build: 'INSUFFICIENT_FUNDS' };
      return 'ok';
    },
    rfq: () => !direct && random() < 0.3,
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
      if (direct) {
        if (r < 0.6) return 'ok';
        // Refused in preflight, or (a sell) the curve moved below the minimum just before
        // the send: never sent, so it never lands.
        if (r < 0.7) {
          const moved = selling && random() < 0.5;
          return { fail: moved ? 'PRICE_MOVED' : 'NOT_SENT', signature: 'preflight' };
        }
        // The RPC took it and the answer was lost: it may land later.
        if (r < 0.8) return { fail: 'NETWORK', signature: 'lost', ...later(0.6) };
        // Not confirmed before the deadline: it may still land.
        if (r < 0.88) return { fail: 'TIMEOUT', signature: 'slow', ...later(0.5) };
        // Landed with an error (slippage on the curve).
        return { code: -1000, lands: { ok: false } };
      }
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
    // a sell: a few wallets hold nothing
    maxSpend: selling && i % 17 === 3 ? 0n : 5_000_000n + BigInt(i) * 100_000n,
    // a few cannot afford max spend + reserve, a few were never read
    balance: i % 23 === 7 ? null : i % 19 === 5 ? 1_000_000n : 1_000_000_000n,
  }));
  const rpm = JUPITER_PLAN_RPM[s.plan];
  // One pair for every group, as the vault keeps one pair per plan (SPEC 2.2).
  const orderLimiter = new OrderLimiter({ orderRpm: rpm, clock });
  const executeLimiter = new ExecuteLimiter({ plan: s.plan, orderRpm: rpm, clock });
  const groupOf = (index: number): number => (groups === 2 && index >= s.wallets / 2 ? 1 : 0);
  const mintOf = (group: number): string => (group === 0 ? MINT : MINT_2);
  let simulations = 0;
  let priceMoved = 0;
  const client = direct
    ? {
        getOrder: jupiter.getOrder.bind(jupiter),
        execute: async (request: Parameters<typeof jupiter.execute>[0]) => {
          const result = await jupiter.execute(request);
          if (!result.ok && result.code === 'PRICE_MOVED') priceMoved += 1;
          return result;
        },
        simulate: () => {
          simulations += 1;
          return Promise.resolve(
            random() < 0.1
              ? { ok: false as const, problem: '{"InstructionError":[4,{"Custom":6001}]}' }
              : { ok: true as const, unitsConsumed: 61_000n },
          );
        },
      }
    : jupiter;
  const runs = Array.from({ length: groups }, (_, group) =>
    startRun(
      {
        jupiter: client,
        orderLimiter,
        executeLimiter,
        sign: signer,
        landing: chain.checker,
        clock,
        emit: () => undefined,
      },
      {
        runId: s.seed * 10 + group,
        ...(selling ? { side } : {}),
        mint: mintOf(group),
        wallets: wallets.filter((w) => groupOf(w.index) === group),
        dryRun: s.dryRun,
        maxAttempts: 3,
        minReserveLamports: 15_000_000n,
        priceCeilingPercent: 50,
        noRouteWindowMs: 20_000,
        noRouteBackoffMinMs: 500,
        noRouteBackoffMaxMs: 2_000,
        ...(stairs === null
          ? {}
          : { stairs: { intervalMs: stairs.intervalMs, perStep: stairs.perStep } }),
      },
    ),
  );
  const summaries: (RunSummary | null)[] = runs.map(() => null);
  runs.forEach((run, i) => {
    void run.done.then((r) => {
      summaries[i] = r;
    });
  });
  const marks: { stoppedAt: number | null; pausedFrom: number | null; pausedTo: number | null } = {
    stoppedAt: null,
    pausedFrom: null,
    pausedTo: null,
  };
  const actions: { at: number; act: () => void }[] = [];
  if (s.stopAt !== null) {
    actions.push({
      at: s.stopAt,
      act: () => {
        runs[0]?.stop();
        marks.stoppedAt = clock.now();
      },
    });
  }
  const pause = stairs?.pause ?? null;
  if (pause !== null) {
    actions.push({
      at: pause.at,
      act: () => {
        if (runs[0]?.pause() === true) marks.pausedFrom = clock.now();
      },
    });
    actions.push({
      at: pause.at + pause.forMs,
      act: () => {
        if (marks.pausedFrom !== null && runs[0]?.resume() === true) marks.pausedTo = clock.now();
      },
    });
  }
  actions.sort((a, b) => a.at - b.at);
  for (const action of actions) {
    await clock.runUntil(T0 + action.at);
    action.act();
  }
  await clock.runUntil();
  const { stoppedAt } = marks;

  const broken: string[] = [];
  const finished = summaries.filter((r): r is RunSummary => r !== null);
  if (finished.length !== runs.length) {
    return {
      broken: ['the run did not finish'],
      outcomes: {},
      executes: 0,
      chainChecks: 0,
      landedWithError: 0,
      durationMs: 0,
      sharedFullWindow: false,
      paused: false,
      simulations: 0,
      priceMoved: 0,
    };
  }
  const done = { wallets: finished.flatMap((r) => r.wallets) };
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
    // The route comes within the window (≤ 8,6 s of 500 and "no route" vs 20 s), and later
    // random 503s re-close the gate with a fresh window each time (D-035): nobody may
    // end without a route.
    if (w.reason?.code === 'NO_ROUTE') broken.push(`${taker}: FAILED NO_ROUTE with a route`);
    // "no route" and HTTP 500 from /order never use attempts (D-035)
    if (
      w.reason?.code === 'MAX_ATTEMPTS' &&
      (w.reason.detail === 'NO_ROUTE' || w.reason.detail === 'SERVER_ERROR')
    ) {
      broken.push(`${taker}: MAX_ATTEMPTS from ${w.reason.detail}`);
    }
    const buys = chain.successfulBuys(taker);
    if (buys.length > 1) broken.push(`${taker}: ${String(buys.length)} buys`);
    const spent = buys.reduce((sum, b) => sum + b.spent, 0n);
    if (spent > maxSpend) broken.push(`${taker}: spent ${String(spent)} > ${String(maxSpend)}`);
    if ((w.state === 'CONFIRMED') !== (buys.length === 1)) {
      broken.push(`${taker}: ${w.state} but ${String(buys.length)} buys on the chain`);
    }
  }
  // Every /order of every group counts against the one plan limit.
  const orderCalls = jupiter.calls
    .filter((c) => c.kind === 'order')
    .sort((a, b) => a.start - b.start);
  const starts = orderCalls.map((c) => c.start);
  const budget = orderBudget(rpm);
  for (let i = 0; i + budget < starts.length; i++) {
    const a = starts[i] ?? 0;
    const b = starts[i + budget] ?? 0;
    if (b - a < ORDER_WINDOW_MS)
      broken.push(`more than ${String(budget)} /order in 60 s at ${String(a - T0)}`);
  }
  const groupOfTaker = new Map(wallets.map((w) => [w.address, groupOf(w.index)]));
  const sharedFullWindow =
    groups === 2 &&
    orderCalls.some((first, i) => {
      const window = orderCalls.slice(i).filter((c) => c.start - first.start < ORDER_WINDOW_MS);
      const both = new Set(window.map((c) => groupOfTaker.get(c.taker)));
      return window.length === budget && both.size === 2;
    });
  if (s.dryRun && jupiter.executions().length > 0) broken.push('/execute in DRY-RUN');
  if (direct) {
    // DRY-RUN simulates each signed buy once and only then skips it; live never simulates.
    const dryRuns = outcomes['SKIPPED:DRY_RUN'] ?? 0;
    const refused = done.wallets.filter((w) => w.reason?.detail?.startsWith('SIMULATION_FAILED'));
    if (!s.dryRun && simulations > 0) broken.push(`${String(simulations)} simulations live`);
    if (s.dryRun && simulations !== dryRuns + refused.length) {
      broken.push(`${String(simulations)} simulations for ${String(dryRuns + refused.length)}`);
    }
  }
  if (stoppedAt !== null) {
    // STOP of the first group: none of its wallets asks again; the second goes on.
    const stop = stoppedAt;
    const after = orderCalls.filter((c) => c.start > stop && groupOfTaker.get(c.taker) === 0);
    if (after.length > 0) broken.push(`${String(after.length)} /order after STOP`);
  }
  if (jupiter.maxOpenPerWallet > 1) broken.push('two calls in flight for one wallet');
  if (stairs !== null) {
    // Worked out apart from the executor: step k is due at k intervals after the start;
    // a step not due before the pause moves by the whole pause (to the end if never resumed).
    const { pausedFrom, pausedTo } = marks;
    const shift = pausedFrom === null ? 0 : (pausedTo ?? Infinity) - pausedFrom;
    const dueAt = (k: number): number => {
      const at = T0 + k * stairs.intervalMs;
      return pausedFrom === null || at <= pausedFrom ? at : at + shift;
    };
    const firsts = [...new Set(orderCalls.map((c) => c.taker))].map(
      (taker) => orderCalls.find((c) => c.taker === taker)?.start ?? 0,
    );
    firsts.forEach((at, i) => {
      let due = 0;
      while (due * stairs.perStep < s.wallets && dueAt(due) <= at) due++;
      if (i + 1 > due * stairs.perStep) {
        broken.push(`wallet ${String(i + 1)} asked at ${String(at - T0)} before its step`);
      }
    });
    if (pausedFrom !== null) {
      const end = pausedTo ?? Infinity;
      const during = orderCalls.filter((c) => c.start > pausedFrom && c.start < end);
      if (during.length > 0) broken.push(`${String(during.length)} /order while paused`);
    }
  }
  // Every /order is for this wallet's planned amount, in the direction of the run.
  const planOf = new Map(wallets.map((w) => [w.address, w.maxSpend]));
  for (const r of jupiter.orderRequests()) {
    const mint = mintOf(groupOfTaker.get(r.taker ?? '') ?? -1);
    const direction = selling
      ? r.inputMint === mint && r.outputMint === SOL_MINT
      : r.inputMint === undefined && r.outputMint === mint;
    if (!direction) broken.push(`${r.taker ?? '?'}: /order in the wrong direction`);
    if (r.amount !== planOf.get(r.taker ?? '') || r.amount <= 0n) {
      broken.push(`${r.taker ?? '?'}: /order for ${String(r.amount)}, not the plan`);
    }
  }
  return {
    broken,
    outcomes,
    executes: jupiter.executions().length,
    chainChecks: chain.checks,
    landedWithError: chain.landed.filter((l) => !l.ok).length,
    durationMs: clock.now() - T0,
    sharedFullWindow,
    paused: marks.pausedFrom !== null,
    simulations,
    priceMoved,
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
    expect(all.some((s) => s.serverErrorMs > 0)).toBe(true);
  });
});

describe(`fleet invariants of a sell (${String(SELL_SEEDS)} seeds${LONG ? ', long set' : ''})`, () => {
  const seeds = Array.from({ length: SELL_SEEDS }, (_, i) => FIRST_SELL_SEED + i);

  const results: SimResult[] = [];

  it.each(seeds)(
    'sell seed %i',
    async (seed) => {
      const s = scenario(seed);
      const result = await simulate(s, 'sell');
      results.push(result);
      expect(result.broken, JSON.stringify(s)).toEqual([]);
    },
    60_000,
  );

  it('the sell runs went through every path (not a vacuous pass)', () => {
    expect(results).toHaveLength(SELL_SEEDS);
    const total: Record<string, number> = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.outcomes)) total[k] = (total[k] ?? 0) + v;
    }
    for (const key of [
      'CONFIRMED',
      'SKIPPED:DRY_RUN',
      'SKIPPED:STOPPED',
      'SKIPPED:NO_TOKENS',
      'SKIPPED:INSUFFICIENT_FUNDS',
      'FAILED:MAX_ATTEMPTS',
      'FAILED:EXECUTE_FAILED',
    ]) {
      expect(total[key] ?? 0, key).toBeGreaterThan(0);
    }
    // what belongs to a buy only never happens to a sell
    for (const key of [
      'SKIPPED:PRICE_CEILING',
      'SKIPPED:INSUFFICIENT_SOL',
      'SKIPPED:BALANCE_UNKNOWN',
    ]) {
      expect(total[key] ?? 0, key).toBe(0);
    }
    expect(results.reduce((n, r) => n + r.executes, 0)).toBeGreaterThan(SELL_SEEDS * 20);
    expect(results.reduce((n, r) => n + r.chainChecks, 0)).toBeGreaterThan(SELL_SEEDS * 10);
    expect(results.reduce((n, r) => n + r.landedWithError, 0)).toBeGreaterThan(0);
  });

  it('the sell scenarios cover live, DRY-RUN and STOP', () => {
    const all = seeds.map(scenario);
    expect(new Set(all.map((s) => s.dryRun))).toEqual(new Set([true, false]));
    expect(all.some((s) => s.stopAt !== null)).toBe(true);
  });
});

describe(`two wallet groups at once (${String(GROUP_SEEDS)} seeds${LONG ? ', long set' : ''})`, () => {
  const seeds = Array.from({ length: GROUP_SEEDS }, (_, i) => FIRST_GROUP_SEED + i);
  /** The /order budget per 60 s, worked out by hand: 90 % of 30 and of 60 a minute. */
  const BUDGET = { keyless: 27, free: 54 } as const;

  const results: SimResult[] = [];

  it('the budget in the invariant is the hand-worked one', () => {
    expect(orderBudget(JUPITER_PLAN_RPM.keyless)).toBe(BUDGET.keyless);
    expect(orderBudget(JUPITER_PLAN_RPM.free)).toBe(BUDGET.free);
  });

  it.each(seeds)(
    'groups seed %i',
    async (seed) => {
      const s = scenario(seed);
      const result = await simulate(s, 'buy', 2);
      results.push(result);
      expect(result.broken, JSON.stringify(s)).toEqual([]);
    },
    60_000,
  );

  it('the two groups really shared full windows (not a vacuous pass)', () => {
    expect(results).toHaveLength(GROUP_SEEDS);
    expect(results.some((r) => r.sharedFullWindow)).toBe(true);
    expect(results.reduce((n, r) => n + r.executes, 0)).toBeGreaterThan(GROUP_SEEDS * 20);
  });
});

describe(`Stairs (${String(STAIRS_SEEDS)} seeds${LONG ? ', long set' : ''})`, () => {
  const seeds = Array.from({ length: STAIRS_SEEDS }, (_, i) => FIRST_STAIRS_SEED + i);

  const results: SimResult[] = [];

  it.each(seeds)(
    'stairs seed %i',
    async (seed) => {
      const s = scenario(seed);
      const plan = stairsPlan(seed);
      const result = await simulate(s, 'buy', 1, plan);
      results.push(result);
      expect(result.broken, JSON.stringify({ ...s, ...plan })).toEqual([]);
    },
    60_000,
  );

  it('the Stairs runs were paused, stopped and confirmed buys (not a vacuous pass)', () => {
    expect(results).toHaveLength(STAIRS_SEEDS);
    expect(results.some((r) => r.paused)).toBe(true);
    expect(results.some((r) => (r.outcomes['SKIPPED:STOPPED'] ?? 0) > 0)).toBe(true);
    expect(results.reduce((n, r) => n + (r.outcomes.CONFIRMED ?? 0), 0)).toBeGreaterThan(0);
    expect(results.reduce((n, r) => n + r.executes, 0)).toBeGreaterThan(STAIRS_SEEDS * 20);
  });
});

describe(`the direct route (${String(DIRECT_SEEDS)} seeds${LONG ? ', long set' : ''})`, () => {
  const seeds = Array.from({ length: DIRECT_SEEDS }, (_, i) => FIRST_DIRECT_SEED + i);

  const results: SimResult[] = [];

  it.each(seeds)(
    'direct seed %i',
    async (seed) => {
      const s = scenario(seed);
      const result = await simulate(s, 'buy', 1, null, 'direct');
      results.push(result);
      expect(result.broken, JSON.stringify(s)).toEqual([]);
    },
    60_000,
  );

  it('the direct runs went through every path (not a vacuous pass)', () => {
    expect(results).toHaveLength(DIRECT_SEEDS);
    const total: Record<string, number> = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.outcomes)) total[k] = (total[k] ?? 0) + v;
    }
    for (const key of [
      'CONFIRMED',
      'SKIPPED:DRY_RUN',
      'SKIPPED:INSUFFICIENT_FUNDS',
      'FAILED:CHECK_FAILED',
      'FAILED:MAX_ATTEMPTS',
    ]) {
      expect(total[key] ?? 0, key).toBeGreaterThan(0);
    }
    expect(results.reduce((n, r) => n + r.simulations, 0)).toBeGreaterThan(0);
    expect(results.reduce((n, r) => n + r.chainChecks, 0)).toBeGreaterThan(DIRECT_SEEDS * 10);
    expect(results.reduce((n, r) => n + r.landedWithError, 0)).toBeGreaterThan(0);
  });
});

describe(`direct-route sells (${String(DIRECT_SELL_SEEDS)} seeds${LONG ? ', long set' : ''})`, () => {
  const seeds = Array.from({ length: DIRECT_SELL_SEEDS }, (_, i) => FIRST_DIRECT_SELL_SEED + i);

  const results: SimResult[] = [];

  it.each(seeds)(
    'direct sell seed %i',
    async (seed) => {
      const s = scenario(seed);
      const result = await simulate(s, 'sell', 1, null, 'direct');
      results.push(result);
      expect(result.broken, JSON.stringify(s)).toEqual([]);
    },
    60_000,
  );

  it('the direct sells went through every path (not a vacuous pass)', () => {
    expect(results).toHaveLength(DIRECT_SELL_SEEDS);
    const total: Record<string, number> = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.outcomes)) total[k] = (total[k] ?? 0) + v;
    }
    for (const key of [
      'CONFIRMED',
      'SKIPPED:DRY_RUN',
      'SKIPPED:NO_TOKENS',
      'SKIPPED:INSUFFICIENT_SOL_FOR_GAS',
      'FAILED:MAX_ATTEMPTS',
    ]) {
      expect(total[key] ?? 0, key).toBeGreaterThan(0);
    }
    for (const key of ['SKIPPED:PRICE_CEILING', 'SKIPPED:INSUFFICIENT_SOL']) {
      expect(total[key] ?? 0, key).toBe(0);
    }
    expect(results.reduce((n, r) => n + r.priceMoved, 0)).toBeGreaterThan(0);
    expect(results.reduce((n, r) => n + r.simulations, 0)).toBeGreaterThan(0);
    expect(results.reduce((n, r) => n + r.chainChecks, 0)).toBeGreaterThan(DIRECT_SELL_SEEDS * 5);
    expect(results.reduce((n, r) => n + r.landedWithError, 0)).toBeGreaterThan(0);
  });
});
