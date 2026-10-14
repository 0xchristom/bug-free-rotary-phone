/**
 * A buy amount given as a percent of the wallet's SOL balance (SPEC 11.3, BUNNDLY-58).
 * Pure integer maths on lamports, rounded down, and never into the reserve: what stays in
 * the wallet after the buy is at least MIN_RESERVE_SOL.
 */

export function isBuyPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;
}

/**
 * `min(floor(balance × percent / 100), balance − reserve)`; 0 when the balance does not
 * exceed the reserve. A wallet with 0 is skipped as INSUFFICIENT_SOL without a request.
 */
export function percentBuyAmount(balance: bigint, percent: number, reserve: bigint): bigint {
  if (!isBuyPercent(percent)) throw new RangeError('buy percent must be an integer 1-100');
  const free = balance - reserve;
  if (free <= 0n) return 0n;
  const share = (balance * BigInt(percent)) / 100n;
  return share < free ? share : free;
}
