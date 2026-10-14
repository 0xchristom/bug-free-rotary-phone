/**
 * DBC buy math on hand-made curves (BUNNDLY-47). Every expected number is worked out by
 * hand in the comment above it, never taken from the module. Real pools are checked in
 * meteora-dbc-fixtures.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  BaseFeeMode,
  CollectFeeMode,
  getBaseFeeNumerator,
  getTotalFeeNumerator,
  minimumAmountOut,
  quoteBuyExactIn,
  type QuoteConfig,
  type QuotePool,
} from '../../src/direct/meteora-dbc/math.ts';

const Q64 = 1n << 64n;
/** One curve segment from √P = 1 (2^64) to √P = 2, L = 1e9·2^64: a full segment takes 1e9 lamports. */
const L = 1_000_000_000n * Q64;

function config(over: Partial<QuoteConfig> = {}): QuoteConfig {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: 0n,
        firstFactor: 0,
        secondFactor: 0n,
        thirdFactor: 0n,
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      },
      dynamicFee: { initialized: 0, binStep: 0, variableFeeControl: 0 },
    },
    collectFeeMode: CollectFeeMode.QuoteToken,
    migrationQuoteThreshold: 10n ** 12n,
    migrationSqrtPrice: 2n * Q64,
    curve: [{ sqrtPrice: 2n * Q64, liquidity: L }],
    ...over,
  };
}

const pool: QuotePool = {
  sqrtPrice: Q64,
  quoteReserve: 0n,
  activationPoint: 0n,
  volatilityAccumulator: 0n,
};

function ok(r: ReturnType<typeof quoteBuyExactIn>) {
  if (r.kind !== 'ok') throw new Error(`expected a quote, got ${r.kind}`);
  return r.quote;
}

describe('quoteBuyExactIn on a hand-made curve', () => {
  it('half the segment: √P goes 1 → 1.5, tokens = L·0.5/(1·1.5) = 1e9/3 rounded down', () => {
    // next = 2^64 + (5e8 << 128) / (1e9·2^64) = 2^64 + 2^63
    // out = floor(1e9·2^64 · 2^63 / (2^64 · 1.5·2^64)) = floor(1e9 / 3) = 333 333 333
    const q = ok(quoteBuyExactIn(pool, config(), 500_000_000n, 0n));
    expect(q.nextSqrtPrice).toBe(Q64 + (Q64 >> 1n));
    expect(q.outputAmount).toBe(333_333_333n);
    expect(q.excludedFeeInputAmount).toBe(500_000_000n);
  });

  it('the whole segment: exactly 1e9 lamports reach √P = 2 and give 1e9/2 tokens', () => {
    // out = 1e9·2^64·2^64 / (2^64·2^65) = 5e8; nothing is left over
    const q = ok(quoteBuyExactIn(pool, config(), 1_000_000_000n, 0n));
    expect(q.nextSqrtPrice).toBe(2n * Q64);
    expect(q.outputAmount).toBe(500_000_000n);
  });

  it('fee on the input (QuoteToken): 1% comes off before the curve, 20% of it is the protocol share', () => {
    // fee = ceil(1e9·1e7/1e9) = 1e7; protocol = 2e6; trading = 8e6; 9.9e8 reaches the curve.
    // next = 2^64 + floor(9.9e8·2^128 / (1e9·2^64)) = 2^64 + floor(0.99·2^64)
    const cfg = config({
      poolFees: {
        ...config().poolFees,
        baseFee: { ...config().poolFees.baseFee, cliffFeeNumerator: 10_000_000n },
      },
    });
    const q = ok(quoteBuyExactIn(pool, cfg, 1_000_000_000n, 0n));
    expect(q.excludedFeeInputAmount).toBe(990_000_000n);
    expect(q.tradingFee).toBe(8_000_000n);
    expect(q.protocolFee).toBe(2_000_000n);
    const next = Q64 + (99n * Q64) / 100n;
    expect(q.nextSqrtPrice).toBe(next);
    // out = floor(1e9·(next − 2^64)·2^64 / (2^64·next)) = floor(1e9·0.99/1.99) = 497 487 437
    expect(q.outputAmount).toBe(497_487_437n);
  });

  it('fee on the output (OutputToken): the curve takes everything, 1% of the tokens is kept', () => {
    // curve: 5e8 lamports → 333 333 333 tokens (first test); fee = ceil(333 333 333·0.01) = 3 333 334
    const cfg = config({
      collectFeeMode: CollectFeeMode.OutputToken,
      poolFees: {
        ...config().poolFees,
        baseFee: { ...config().poolFees.baseFee, cliffFeeNumerator: 10_000_000n },
      },
    });
    const q = ok(quoteBuyExactIn(pool, cfg, 500_000_000n, 0n));
    expect(q.excludedFeeInputAmount).toBe(500_000_000n);
    expect(q.outputAmount).toBe(333_333_333n - 3_333_334n);
  });

  it('two segments: the rest after √P = 2 is priced on the second one', () => {
    // segment 2: √P 2 → 4 with L2 = 2e9·2^64 holds 2e9·2 = 4e9 lamports.
    // 1e9 fills segment 1 (5e8 tokens); 2e9 more on segment 2: next = 2 + 2e9/2e9 = 3 (·2^64)
    // tokens = 2e9·(3−2)/(2·3) = 333 333 333 (floor of 1e9/3)
    const cfg = config({
      migrationSqrtPrice: 4n * Q64,
      curve: [
        { sqrtPrice: 2n * Q64, liquidity: L },
        { sqrtPrice: 4n * Q64, liquidity: 2n * L },
      ],
    });
    const q = ok(quoteBuyExactIn(pool, cfg, 3_000_000_000n, 0n));
    expect(q.nextSqrtPrice).toBe(3n * Q64);
    expect(q.outputAmount).toBe(500_000_000n + 333_333_333n);
  });
});

describe('segment capacity rounding (L·Δ not a multiple of 2^128)', () => {
  // Segment √P 1 → 2 with L = 3·2^63 + 1: capacity L·2^64 / 2^128 = 1.5 + ε lamports,
  // rounded UP to 2 (rounded down it would be 1).
  const odd = 3n * (1n << 63n) + 1n;
  const cfg = config({ curve: [{ sqrtPrice: 2n * Q64, liquidity: odd }] });

  it('1 lamport stays inside the segment: √P moves by 2^128/L, zero tokens', () => {
    // 1 < 2 → partial step: next = 2^64 + floor(2^128 / L); tokens = floor(L·Δ/(2^64·next)) ≈ 0.6 → 0
    const q = ok(quoteBuyExactIn(pool, cfg, 1n, 0n));
    expect(q.nextSqrtPrice).toBe(Q64 + (1n << 128n) / odd);
    expect(q.outputAmount).toBe(0n);
  });

  it('2 lamports (= the rounded-up capacity) end exactly at the segment top', () => {
    // 2 is not < 2 → the whole segment: next = 2^65, tokens = floor(L·2^64/(2^64·2^65)) = floor(L/2^65)
    // = floor(0.75 + ε) = 0.
    // A partial step would overshoot: 2^64 + floor(2·2^128/L) > 2^65.
    const q = ok(quoteBuyExactIn(pool, cfg, 2n, 0n));
    expect(q.nextSqrtPrice).toBe(2n * Q64);
    expect(q.outputAmount).toBe(0n);
  });
});

describe('explicit results instead of a wrong quote', () => {
  it('more than the curve holds up to the migration price: insufficient liquidity with the rest', () => {
    // the curve takes 1e9 up to √P = 2 = migration price; 1.25e9 leaves 2.5e8
    const r = quoteBuyExactIn(pool, config(), 1_250_000_000n, 0n);
    expect(r).toEqual({ kind: 'insufficient-liquidity', amountLeft: 250_000_000n });
  });

  it('quote reserve at the migration threshold: completed, for any amount', () => {
    const full = { ...pool, quoteReserve: 10n ** 12n };
    expect(quoteBuyExactIn(full, config(), 1n, 0n)).toEqual({ kind: 'completed' });
  });

  it('zero or above u64 is refused', () => {
    expect(() => quoteBuyExactIn(pool, config(), 0n, 0n)).toThrow(RangeError);
    expect(() => quoteBuyExactIn(pool, config(), 1n << 64n, 0n)).toThrow(RangeError);
  });
});

describe('base fee', () => {
  const fee = (over: Partial<Parameters<typeof getBaseFeeNumerator>[0]>) => ({
    cliffFeeNumerator: 100_000_000n,
    firstFactor: 10,
    secondFactor: 60n,
    thirdFactor: 10_000_000n,
    baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
    ...over,
  });

  it('linear scheduler: 10% minus 1% per 60-point period, held at the last period', () => {
    // 150 points after activation → period 2 → 1e8 − 2·1e7 = 8e7
    expect(getBaseFeeNumerator(fee({}), 1150n, 1000n, 1n)).toBe(80_000_000n);
    // 10 000 points → period 166, capped at numberOfPeriod 5 → 1e8 − 5e7 = 5e7
    expect(getBaseFeeNumerator(fee({ firstFactor: 5 }), 11_000n, 1000n, 1n)).toBe(50_000_000n);
  });

  it('exponential scheduler: halving per period (5000 bps), two periods → a quarter', () => {
    // (1 − 0.5)^2 = 0.25 exactly in Q64 → 1e8 · 0.25 = 2.5e7
    const f = fee({ baseFeeMode: BaseFeeMode.FeeSchedulerExponential, thirdFactor: 5000n });
    expect(getBaseFeeNumerator(f, 120n, 0n, 1n)).toBe(25_000_000n);
    expect(getBaseFeeNumerator(f, 59n, 0n, 1n)).toBe(100_000_000n);
  });

  it('rate limiter: 1% up to 1 SOL, +1% for each further SOL, inside the limiter window', () => {
    // 2.5 SOL: 1 SOL at 1% + 1 SOL at 2% + 0.5 SOL at 3% = 1e7 + 2e7 + 1.5e7 = 4.5e7 lamports;
    // numerator = 4.5e7 · 1e9 / 2.5e9 = 1.8e7
    const f = {
      cliffFeeNumerator: 10_000_000n,
      firstFactor: 100,
      secondFactor: 100n,
      thirdFactor: 1_000_000_000n,
      baseFeeMode: BaseFeeMode.RateLimiter,
    };
    expect(getBaseFeeNumerator(f, 50n, 0n, 2_500_000_000n)).toBe(18_000_000n);
    // at or under the reference amount: the cliff fee
    expect(getBaseFeeNumerator(f, 50n, 0n, 1_000_000_000n)).toBe(10_000_000n);
    // the last point of the window (activation 0 + 100) still counts
    expect(getBaseFeeNumerator(f, 100n, 0n, 2_500_000_000n)).toBe(18_000_000n);
    // after the window: the cliff fee for any amount
    expect(getBaseFeeNumerator(f, 101n, 0n, 2_500_000_000n)).toBe(10_000_000n);
  });

  it('rate limiter past the last step: every further SOL pays the 99% cap', () => {
    // cliff 97%, +1% per SOL: 97%, 98%, 99% (max index 2), then 99% flat.
    // 4 SOL: 0.97 + 0.98 + 0.99 + 0.99 = 3.93 SOL fee → numerator 3.93/4 · 1e9 = 982 500 000
    // 5 SOL: 3.93 + 0.99 = 4.92 SOL → 4.92/5 · 1e9 = 984 000 000
    const f = {
      cliffFeeNumerator: 970_000_000n,
      firstFactor: 100,
      secondFactor: 100n,
      thirdFactor: 1_000_000_000n,
      baseFeeMode: BaseFeeMode.RateLimiter,
    };
    expect(getBaseFeeNumerator(f, 0n, 0n, 4_000_000_000n)).toBe(982_500_000n);
    expect(getBaseFeeNumerator(f, 0n, 0n, 5_000_000_000n)).toBe(984_000_000n);
  });

  it('dynamic fee adds (va·binStep)²·control/1e11 rounded up, and the total is capped at 99%', () => {
    // (1e5·100)² · 100 = 1e16 → ceil(1e16 / 1e11) = 1e5
    const fees = {
      baseFee: fee({ secondFactor: 0n }),
      dynamicFee: { initialized: 1, binStep: 100, variableFeeControl: 100 },
    };
    const p = { ...pool, volatilityAccumulator: 100_000n };
    expect(getTotalFeeNumerator(fees, p, 0n, 1n)).toBe(100_000_000n + 100_000n);
    const capped = { ...fees, baseFee: fee({ cliffFeeNumerator: 989_990_000n, secondFactor: 0n }) };
    expect(getTotalFeeNumerator(capped, p, 0n, 1n)).toBe(990_000_000n);
  });
});

describe('minimumAmountOut', () => {
  it('slippage 0, 1% and 50%, always rounded down', () => {
    expect(minimumAmountOut(999_999n, 0)).toBe(999_999n);
    // 999 999 · 0.99 = 989 999.01 → 989 999
    expect(minimumAmountOut(999_999n, 100)).toBe(989_999n);
    // 999 999 · 0.5 = 499 999.5 → 499 999
    expect(minimumAmountOut(999_999n, 5000)).toBe(499_999n);
    // 1 · 0.99 = 0.99 → 0
    expect(minimumAmountOut(1n, 100)).toBe(0n);
  });

  it('refuses a slippage outside 0..10000 bps or not an integer', () => {
    expect(() => minimumAmountOut(1n, -1)).toThrow(RangeError);
    expect(() => minimumAmountOut(1n, 10_001)).toThrow(RangeError);
    expect(() => minimumAmountOut(1n, 1.5)).toThrow(RangeError);
  });
});
