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

/** Percent with up to 2 decimals → basis points (1 % = 100); null outside 0–100 %. */
export function parsePercent(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/u.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp > 0 && bp <= 10_000 ? bp : null;
}

/** floor(balance × bp / 10 000): never more than the given share of the balance. */
export function shareOf(balance: bigint, basisPoints: number): bigint {
  return (balance * BigInt(basisPoints)) / 10_000n;
}

export interface SummaryRow extends RowInput {
  readonly token: bigint | null;
}

export interface FleetSummary {
  /** Sum of the known SOL balances. */
  readonly totalLamports: bigint;
  /** Sum of max spend over the wallets that are ready to buy. */
  readonly toSpendLamports: bigint;
  readonly readyCount: number;
  /** Sum of the token balances, or null when no token is shown. */
  readonly totalToken: bigint | null;
}

export function summarize(rows: readonly SummaryRow[]): FleetSummary {
  let totalLamports = 0n;
  let toSpendLamports = 0n;
  let readyCount = 0;
  let totalToken: bigint | null = null;
  for (const row of rows) {
    if (row.balance !== null) totalLamports += row.balance;
    if (row.token !== null) totalToken = (totalToken ?? 0n) + row.token;
    if (rowState(row).ready && row.maxSpend !== null) {
      readyCount += 1;
      toSpendLamports += row.maxSpend;
    }
  }
  return { totalLamports, toSpendLamports, readyCount, totalToken };
}
