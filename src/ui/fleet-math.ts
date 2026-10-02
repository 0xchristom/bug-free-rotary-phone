/**
 * Fleet table arithmetic (SPEC 3.2), all on bigint lamports: reserve = balance − max
 * spend, and a wallet is ready to buy only when it is active, has a max spend, a known
 * balance and a reserve of at least MIN_RESERVE_SOL.
 */

export interface RowInput {
  /** null until the first balance read. */
  readonly balance: bigint | null;
  /** null when no max spend is set for the wallet. */
  readonly maxSpend: bigint | null;
  readonly minReserve: bigint;
  readonly active: boolean;
}

export interface RowState {
  readonly reserve: bigint | null;
  /** Reserve below MIN_RESERVE_SOL (including a max spend above the balance). */
  readonly reserveTooLow: boolean;
  readonly overBalance: boolean;
  readonly ready: boolean;
}

export function rowState({ balance, maxSpend, minReserve, active }: RowInput): RowState {
  if (balance === null || maxSpend === null) {
    return { reserve: null, reserveTooLow: false, overBalance: false, ready: false };
  }
  const reserve = balance - maxSpend;
  const reserveTooLow = reserve < minReserve;
  return {
    reserve,
    reserveTooLow,
    overBalance: maxSpend > balance,
    ready: active && maxSpend > 0n && !reserveTooLow,
  };
}
