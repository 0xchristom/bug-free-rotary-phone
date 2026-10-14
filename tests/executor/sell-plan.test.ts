/** Planned sell amount (BUNNDLY-60). Expected numbers are worked out by hand, not by the code. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SELL_PERCENT, isSellPercent, sellAmount } from '../../src/executor/index.ts';

describe('sellAmount', () => {
  it('6 decimals: 1234.567891 tokens, rounded down to the raw unit', () => {
    const balance = 1_234_567_891n;
    // 1 234 567 891 / 4 = 308 641 972,75 and / 2 = 617 283 945,5
    expect(sellAmount(balance, 25)).toBe(308_641_972n);
    expect(sellAmount(balance, 50)).toBe(617_283_945n);
    expect(sellAmount(balance, 100)).toBe(1_234_567_891n);
  });

  it('9 decimals, above 2^53: no precision is lost', () => {
    const balance = 987_654_321_987_654_321n;
    // / 4 = 246 913 580 496 913 580,25 and / 2 = 493 827 160 993 827 160,5
    expect(sellAmount(balance, 25)).toBe(246_913_580_496_913_580n);
    expect(sellAmount(balance, 50)).toBe(493_827_160_993_827_160n);
    expect(sellAmount(balance, 100)).toBe(987_654_321_987_654_321n);
  });

  it('never rounds up: 1 % of 99 units is 0, 99 % of 1 unit is 0', () => {
    expect(sellAmount(99n, 1)).toBe(0n);
    expect(sellAmount(100n, 1)).toBe(1n);
    expect(sellAmount(1n, 99)).toBe(0n);
    expect(sellAmount(3n, 33)).toBe(0n); // 0,99
    expect(sellAmount(3n, 34)).toBe(1n); // 1,02
  });

  it('an empty balance plans nothing', () => {
    expect(sellAmount(0n, 100)).toBe(0n);
  });

  it('the percent is an integer from 1 to 100; the default sells everything', () => {
    expect(DEFAULT_SELL_PERCENT).toBe(100);
    for (const bad of [0, 101, -1, 2.5, Number.NaN, '50', null, undefined]) {
      expect(isSellPercent(bad), String(bad)).toBe(false);
    }
    expect(isSellPercent(1) && isSellPercent(100)).toBe(true);
    expect(() => sellAmount(10n, 0)).toThrow(RangeError);
    expect(() => sellAmount(10n, 101)).toThrow(RangeError);
    expect(() => sellAmount(10n, 12.5)).toThrow(RangeError);
  });
});
