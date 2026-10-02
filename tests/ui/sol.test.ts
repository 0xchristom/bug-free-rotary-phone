import { describe, expect, it } from 'vitest';
import { formatSol, parseSol } from '../../src/ui/sol.ts';

describe('SOL amounts', () => {
  it.each([
    ['0,015', 15_000_000n],
    ['0.015', 15_000_000n],
    ['1', 1_000_000_000n],
    [' 2,5 ', 2_500_000_000n],
    ['0,000000001', 1n],
  ])('parseSol(%j) = %s lamports', (text, lamports) => {
    expect(parseSol(text)).toBe(lamports);
  });

  it.each(['', 'abc', '-1', '1,', ',5', '0,0000000001', '1e3', '1 000'])(
    'parseSol(%j) = null',
    (text) => {
      expect(parseSol(text)).toBeNull();
    },
  );

  it.each([
    [15_000_000n, '0,015'],
    [1_000_000_000n, '1'],
    [2_500_000_000n, '2,5'],
    [1n, '0,000000001'],
    [0n, '0'],
  ])('formatSol(%s) = %s', (lamports, text) => {
    expect(formatSol(lamports)).toBe(text);
  });
});
