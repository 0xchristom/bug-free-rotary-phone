/**
 * How much of a wallet's token balance a sell puts in (SPEC 11.3 and 11.4, BUNNDLY-60).
 * Pure integer maths on raw token units, rounded down: a wallet never plans more than
 * it holds.
 */

/** Sells everything unless told otherwise. */
export const DEFAULT_SELL_PERCENT = 100;

export function isSellPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

/** `floor(balance × percent / 100)`; 0 for an empty balance. */
export function sellAmount(balance: bigint, percent: number): bigint {
  if (!isSellPercent(percent)) throw new RangeError('sell percent must be an integer 1-100');
  return balance <= 0n ? 0n : (balance * BigInt(percent)) / 100n;
}
