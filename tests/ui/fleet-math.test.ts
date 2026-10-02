import { describe, expect, it } from 'vitest';
import { rowState } from '../../src/ui/fleet-math.ts';
import { formatUnits, parseSolAmount } from '../../src/ui/sol.ts';

const SOL = 1_000_000_000n;
const MIN = 15_000_000n; // 0.015 SOL

describe('parseSolAmount', () => {
  it.each([
    ['0,25', 250_000_000n],
    ['0.25', 250_000_000n],
    ['1', SOL],
    [' 2,000000001 ', 2n * SOL + 1n],
    ['0', 0n],
  ])('%j → %s lamports', (text, lamports) => {
    expect(parseSolAmount(text)).toEqual({ ok: true, lamports });
  });

  it.each([
    ['0,0000000001', 'Podaj najwyżej 9 miejsc po przecinku (1 lamport).'],
    ['1.1234567891', 'Podaj najwyżej 9 miejsc po przecinku (1 lamport).'],
    ['-0,5', 'Kwota nie może być ujemna.'],
    ['-1', 'Kwota nie może być ujemna.'],
    ['abc', 'Podaj kwotę w SOL, np. 0,25.'],
    ['1,2,3', 'Podaj kwotę w SOL, np. 0,25.'],
    ['', 'Podaj kwotę w SOL, np. 0,25.'],
  ])('%j → %s', (text, message) => {
    expect(parseSolAmount(text)).toEqual({ ok: false, message });
  });
});

describe('formatUnits', () => {
  it.each([
    [100n, 6, '0,0001'],
    [393_571_704_253_643n, 6, '393571704,253643'],
    [1_000_000n, 6, '1'],
    [0n, 6, '0'],
    [12345n, 0, '12345'],
    [2n ** 64n - 1n, 9, '18446744073,709551615'],
  ])('formatUnits(%s, %i) = %s', (amount, decimals, text) => {
    expect(formatUnits(amount, decimals)).toBe(text);
  });
});

describe('rowState (bigint)', () => {
  const base = { balance: SOL, maxSpend: SOL - MIN, minReserve: MIN, active: true };

  it('reserve exactly equal to the minimum is ready', () => {
    expect(rowState(base)).toEqual({
      reserve: MIN,
      reserveTooLow: false,
      overBalance: false,
      ready: true,
    });
  });

  it('one lamport less of reserve is too low and not ready', () => {
    expect(rowState({ ...base, maxSpend: SOL - MIN + 1n })).toEqual({
      reserve: MIN - 1n,
      reserveTooLow: true,
      overBalance: false,
      ready: false,
    });
  });

  it('max spend above the balance: negative reserve, too low, over balance', () => {
    const s = rowState({ ...base, maxSpend: 2n * SOL });
    expect(s.reserve).toBe(-SOL);
    expect(s).toMatchObject({ reserveTooLow: true, overBalance: true, ready: false });
  });

  it('inactive, zero max spend, unknown balance or no max spend are not ready', () => {
    expect(rowState({ ...base, active: false }).ready).toBe(false);
    expect(rowState({ ...base, maxSpend: 0n }).ready).toBe(false);
    expect(rowState({ ...base, balance: null })).toEqual({
      reserve: null,
      reserveTooLow: false,
      overBalance: false,
      ready: false,
    });
    expect(rowState({ ...base, maxSpend: null }).ready).toBe(false);
  });

  it('works above 2^53 lamports without losing precision', () => {
    const huge = 2n ** 60n;
    expect(rowState({ ...base, balance: huge, maxSpend: huge - MIN }).reserve).toBe(MIN);
  });
});
