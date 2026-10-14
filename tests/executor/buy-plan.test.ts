/**
 * Buy amount as a percent of the SOL balance (BUNNDLY-58). Every expected number is
 * worked out by hand in the comment next to it.
 */
import { describe, expect, it } from 'vitest';
import { isBuyPercent, percentBuyAmount } from '../../src/executor/buy-plan.ts';

const RESERVE = 15_000_000n; // 0.015 SOL, the default MIN_RESERVE_SOL

describe('percentBuyAmount', () => {
  it('the plain case: 25 % of 2 SOL is 0.5 SOL', () => {
    // 2 000 000 000 × 25 / 100 = 500 000 000; 2 SOL − 0.015 leaves room for it
    expect(percentBuyAmount(2_000_000_000n, 25, RESERVE)).toBe(500_000_000n);
  });

  it('rounds down to the lamport', () => {
    // 1 000 000 001 × 33 / 100 = 330 000 000.33 → 330 000 000
    expect(percentBuyAmount(1_000_000_001n, 33, RESERVE)).toBe(330_000_000n);
  });

  it('capped by the reserve: 100 % of 1 SOL leaves 0.015 SOL in the wallet', () => {
    // 1 000 000 000 − 15 000 000 = 985 000 000 < 1 000 000 000
    expect(percentBuyAmount(1_000_000_000n, 100, RESERVE)).toBe(985_000_000n);
    // 99 % of 0.5 SOL = 495 000 000; 0.5 − 0.015 = 485 000 000 is smaller
    expect(percentBuyAmount(500_000_000n, 99, RESERVE)).toBe(485_000_000n);
  });

  it('a balance at or below the reserve gives 0', () => {
    expect(percentBuyAmount(RESERVE, 50, RESERVE)).toBe(0n);
    expect(percentBuyAmount(10_000_000n, 100, RESERVE)).toBe(0n);
    expect(percentBuyAmount(0n, 100, RESERVE)).toBe(0n);
  });

  it('one lamport above the reserve buys at most that lamport', () => {
    // 15 000 001 × 100 / 100 = 15 000 001, capped at 15 000 001 − 15 000 000 = 1
    expect(percentBuyAmount(15_000_001n, 100, RESERVE)).toBe(1n);
  });

  it('percent is a whole number from 1 to 100', () => {
    for (const p of [1, 50, 100]) expect(isBuyPercent(p)).toBe(true);
    for (const p of [0, 101, 12.5, -1, Number.NaN, '50', null]) expect(isBuyPercent(p)).toBe(false);
    expect(() => percentBuyAmount(1_000_000_000n, 0, RESERVE)).toThrow(RangeError);
  });
});
