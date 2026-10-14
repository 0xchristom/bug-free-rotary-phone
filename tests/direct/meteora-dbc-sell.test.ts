/**
 * DBC sell math (base → SOL) on hand-made curves (BUNNDLY-63). Every expected number is
 * worked out by hand in the comment above it, never taken from the module. Real sells are
 * checked in meteora-dbc-fixtures.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  BaseFeeMode,
  CollectFeeMode,
  getBaseFeeNumerator,
  getNextSqrtPriceFromBaseInput,
  quoteSellExactIn,
  type QuotePool,
  type SellQuoteConfig,
} from '../../src/direct/meteora-dbc/math.ts';

const Q64 = 1n << 64n;
/**
 * One segment from √P = 1 (2^64, the curve start) to √P = 2, L = 1e9·2^64. It holds
 * L·(2−1)/(1·2) = 5e8 tokens and L·(2−1) = 1e9 lamports.
 */
const L = 1_000_000_000n * Q64;

function config(over: Partial<SellQuoteConfig> = {}): SellQuoteConfig {
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
    sqrtStartPrice: Q64,
    curve: [{ sqrtPrice: 2n * Q64, liquidity: L }],
    ...over,
  };
}

/** A pool at the top of the segment: someone bought all 5e8 tokens for 1e9 lamports. */
const pool: QuotePool = {
  sqrtPrice: 2n * Q64,
  quoteReserve: 1_000_000_000n,
  activationPoint: 0n,
  volatilityAccumulator: 0n,
};

const withFee = (cfg: SellQuoteConfig, cliffFeeNumerator: bigint): SellQuoteConfig => ({
  ...cfg,
  poolFees: { ...cfg.poolFees, baseFee: { ...cfg.poolFees.baseFee, cliffFeeNumerator } },
});

function ok(r: ReturnType<typeof quoteSellExactIn>) {
  if (r.kind !== 'ok') throw new Error(`expected a quote, got ${r.kind}`);
  return r.quote;
}

describe('quoteSellExactIn on a hand-made curve', () => {
  it('all 5e8 tokens back: √P goes 2 → 1 and exactly the 1e9 lamports come out', () => {
    // next = ceil(L·2^65 / (L + 5e8·2^65)) = ceil(1e9·2^129 / (2e9·2^64)) = 2^64
    // out = floor(L·2^64 / 2^128) = 1e9
    const q = ok(quoteSellExactIn(pool, config(), 500_000_000n, 0n));
    expect(q.nextSqrtPrice).toBe(Q64);
    expect(q.outputAmount).toBe(1_000_000_000n);
    expect(q.grossOutputAmount).toBe(1_000_000_000n);
  });

  it('1e8 tokens: √P rounds UP to ceil(5/3·2^64), lamports round DOWN to 333 333 333', () => {
    // next = ceil(1e9·2^64·2^65 / (1e9·2^64 + 1e8·2^65)) = ceil(2^65/1.2) = ceil(5·2^64/3);
    // 2^64 ≡ 1 (mod 3), so 5·2^64 ≡ 2 and the ceiling is (5·2^64 + 1)/3.
    // out = floor(1e9·(2^65 − next)/2^64) = floor(1e9·(2^64 − 1)/(3·2^64)) = 333 333 333
    const q = ok(quoteSellExactIn(pool, config(), 100_000_000n, 0n));
    expect(q.nextSqrtPrice).toBe((5n * Q64 + 1n) / 3n);
    expect(q.outputAmount).toBe(333_333_333n);
  });

  it('two segments: the upper one at L2 first, then the rest on curve[0] down to the start', () => {
    // segment 2 is √P 2 → 4 with L2 = 2L; the pool sits at √P = 3.
    // tokens from 3 down to 2 on L2: ceil(2e9·2^128 / (6·2^128)) = ceil(333 333 333.3) = 333 333 334,
    // lamports for it: floor(2e9·2^64·2^64 / 2^128) = 2e9.
    // the other 5e8 tokens take √P 2 → 1 on L: 1e9 lamports (first test). Total 3e9, √P at the start.
    const cfg = config({
      migrationSqrtPrice: 4n * Q64,
      curve: [
        { sqrtPrice: 2n * Q64, liquidity: L },
        { sqrtPrice: 4n * Q64, liquidity: 2n * L },
      ],
    });
    const at3 = { ...pool, sqrtPrice: 3n * Q64, quoteReserve: 3_000_000_000n };
    const q = ok(quoteSellExactIn(at3, cfg, 333_333_334n + 500_000_000n, 0n));
    expect(q.nextSqrtPrice).toBe(Q64);
    expect(q.outputAmount).toBe(3_000_000_000n);
  });

  it('a product above u128 uses L / (L/√P + Δx), rounded down', () => {
    // √P = 2^65, Δx = 2^64: Δx·√P = 2^129 > u128 max.
    // L/√P = 1e9·2^64/2^65 = 5e8 → next = floor(1e9·2^64 / (5e8 + 2^64))
    expect(getNextSqrtPriceFromBaseInput(2n * Q64, L, Q64)).toBe(
      (1_000_000_000n * Q64) / (500_000_000n + Q64),
    );
    // 0 tokens leave √P where it is
    expect(getNextSqrtPriceFromBaseInput(2n * Q64, L, 0n)).toBe(2n * Q64);
  });
});

describe('fee comes off the SOL output in both collect fee modes', () => {
  // 1e8 tokens → 333 333 333 lamports before fees (above). 1% fee: ceil(3 333 333.33) = 3 333 334;
  // protocol = floor(3 333 334·20/100) = 666 666; trading = 3 333 334 − 666 666 = 2 666 668.
  // out = 333 333 333 − 3 333 334 = 329 999 999.
  it.each([
    ['QuoteToken', CollectFeeMode.QuoteToken],
    ['OutputToken', CollectFeeMode.OutputToken],
  ])('%s', (_name, collectFeeMode) => {
    const cfg = withFee(config({ collectFeeMode }), 10_000_000n);
    const q = ok(quoteSellExactIn(pool, cfg, 100_000_000n, 0n));
    // the curve took all the tokens: √P is the one with no fee
    expect(q.nextSqrtPrice).toBe((5n * Q64 + 1n) / 3n);
    expect(q.grossOutputAmount).toBe(333_333_333n);
    expect(q.outputAmount).toBe(329_999_999n);
    expect(q.tradingFee).toBe(2_666_668n);
    expect(q.protocolFee).toBe(666_666n);
    expect(q.referralFee).toBe(0n);
  });

  it('with a referral, 20% of the protocol share goes to it', () => {
    // referral = floor(666 666·20/100) = 133 333; protocol = 666 666 − 133 333 = 533 333
    const q = ok(quoteSellExactIn(pool, withFee(config(), 10_000_000n), 100_000_000n, 0n, true));
    expect(q.referralFee).toBe(133_333n);
    expect(q.protocolFee).toBe(533_333n);
    expect(q.outputAmount).toBe(329_999_999n);
  });

  it('the rate limiter never raises a sell fee, inside its window and above the reference', () => {
    // same limiter as the buy test: a 2.5 SOL buy pays 1.8%, a sell pays the 1% cliff
    const f = {
      cliffFeeNumerator: 10_000_000n,
      firstFactor: 100,
      secondFactor: 100n,
      thirdFactor: 1_000_000_000n,
      baseFeeMode: BaseFeeMode.RateLimiter,
    };
    expect(getBaseFeeNumerator(f, 50n, 0n, 2_500_000_000n, false)).toBe(18_000_000n);
    expect(getBaseFeeNumerator(f, 50n, 0n, 2_500_000_000n, true)).toBe(10_000_000n);
    // through the quote, with a reference of 1e8 so that 5e8 tokens would be 5× above it on the
    // buy side: still the cliff, fee = ceil(1e9·0.01) = 1e7 → 9.9e8 lamports out
    const cfg = config({
      poolFees: { ...config().poolFees, baseFee: { ...f, thirdFactor: 100_000_000n } },
    });
    const q = ok(quoteSellExactIn(pool, cfg, 500_000_000n, 50n));
    expect(q.outputAmount).toBe(990_000_000n);
  });
});

describe('explicit results instead of a wrong quote', () => {
  it('more tokens than the curve holds above its start: insufficient liquidity with the rest', () => {
    // 6e8 tokens, the segment takes 5e8 down to √P = 1 (the start): 1e8 left
    expect(quoteSellExactIn(pool, config(), 600_000_000n, 0n)).toEqual({
      kind: 'insufficient-liquidity',
      amountLeft: 100_000_000n,
    });
  });

  it('quote reserve at the migration threshold: completed, for any amount', () => {
    const full = { ...pool, quoteReserve: 10n ** 12n };
    expect(quoteSellExactIn(full, config(), 1n, 0n)).toEqual({ kind: 'completed' });
  });

  it('zero or above u64 is refused', () => {
    expect(() => quoteSellExactIn(pool, config(), 0n, 0n)).toThrow(RangeError);
    expect(() => quoteSellExactIn(pool, config(), 1n << 64n, 0n)).toThrow(RangeError);
  });
});
