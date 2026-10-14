/**
 * Confirmation of a buy on the chain (SPEC 3.5, BUNNDLY-25, D-031): after CONFIRMED, the
 * wallet's token balance must have grown by `totalOutputAmount` (what Jupiter says reached
 * the wallet, after an output-side fee).
 *
 * The baseline is read once for the whole fleet when the buy starts, in parallel with the
 * first `/order` (no extra wait on the hot path). It is used only when it was read at a
 * slot before the one the buy landed in; otherwise it may already contain the buy, and the
 * result is UNVERIFIABLE rather than a false alarm.
 *
 * The outcome is a warning at most: the wallet's state never changes here.
 *
 * A sell (BUNNDLY-60) is checked the other way round: the token balance must have fallen
 * by `totalInputAmount` (what Jupiter says left the wallet) and the SOL balance must have
 * grown. Only "grown": the docs do not say how the proceeds reach the wallet, and fees and
 * rent move the exact number (D-044). The statuses are the same as for a buy.
 */
import type { Side } from './executor.ts';
import type { LimiterClock } from './limiter.ts';

/** Token balances (raw u64) of the given owners, in order, with the slot they were read at. */
export type TokenReader = (
  owners: readonly string[],
) => Promise<{ readonly amounts: readonly bigint[]; readonly slot: bigint }>;

/** SOL balances (lamports) of the given owners, in order. */
export type SolReader = (owners: readonly string[]) => Promise<readonly bigint[]>;

/** For a sell read "fell" for "grew": its token balance moves the other way. */
export type VerifyStatus =
  /** Grew by exactly `totalOutputAmount`; a sell: fell by `totalInputAmount` and SOL grew. */
  | 'MATCH'
  /** Grew, and no expected amount was known (confirmed from the chain check). */
  | 'INCREASED'
  /** Grew by a different amount (e.g. someone else sent tokens); a sell: or SOL did not grow. */
  | 'MISMATCH'
  /** Did not grow after every re-read. */
  | 'NO_INCREASE'
  /** No usable baseline or no balance read (RPC errors). */
  | 'UNVERIFIABLE';

export const VERIFY_MESSAGES: Record<VerifyStatus, string> = {
  MATCH: 'Confirmed on chain: the token balance grew by the bought amount.',
  INCREASED: 'The token balance grew (Jupiter gave no amount, so there is no comparison).',
  MISMATCH: 'Warning: the token balance grew by a different amount than Jupiter reported.',
  NO_INCREASE: 'Warning: the token balance did not grow after the buy.',
  UNVERIFIABLE: 'The buy could not be confirmed by reading the token balance.',
};

export const SELL_VERIFY_MESSAGES: Record<VerifyStatus, string> = {
  MATCH: 'Confirmed on chain: the token balance fell by the sold amount and the SOL balance grew.',
  INCREASED: 'The token balance fell (Jupiter gave no amount, so there is no comparison).',
  MISMATCH:
    'Warning: the token balance fell by a different amount than Jupiter reported, or the SOL balance did not grow.',
  NO_INCREASE: 'Warning: the token balance did not fall after the sell.',
  UNVERIFIABLE: 'The sell could not be confirmed by reading the balances.',
};

export function verifyMessage(status: VerifyStatus, side: Side = 'buy'): string {
  return (side === 'sell' ? SELL_VERIFY_MESSAGES : VERIFY_MESSAGES)[status];
}

export interface VerifyEvent {
  readonly kind: 'verify';
  /** Present for a sell only. */
  readonly side?: Side;
  readonly runId: number;
  readonly at: number;
  readonly index: number;
  readonly status: VerifyStatus;
  /** `totalOutputAmount` of a buy or `totalInputAmount` of a sell, when known. */
  readonly expected: bigint | null;
  /** Growth of the token balance seen on the chain (a sell: its fall), when read. */
  readonly observed: bigint | null;
  /** A sell only: change of the SOL balance since the start; null when it was not read. */
  readonly solChange?: bigint | null;
}

export interface VerifyWallet {
  readonly index: number;
  readonly address: string;
}

export interface VerifierOptions {
  readonly runId: number;
  /** Buy by default. */
  readonly side?: Side;
  readonly wallets: readonly VerifyWallet[];
  /** Balance reads after CONFIRMED, `intervalMs` apart. */
  readonly reads?: number;
  readonly intervalMs?: number;
}

export const VERIFY_READS = 5;
export const VERIFY_INTERVAL_MS = 2_000;

export interface Verifier {
  /**
   * Starts the check of one confirmed wallet. Never throws. `expected` is the buy's
   * `totalOutputAmount` or the sell's `totalInputAmount`.
   */
  confirmed(index: number, landedSlot: bigint | null, expected: bigint | null): void;
  /** Resolves when every started check has emitted its event. */
  idle(): Promise<void>;
}

export function createVerifier(
  deps: {
    readonly read: TokenReader;
    /** SOL balances, for a sell: without them a sell cannot be confirmed. */
    readonly sol?: SolReader;
    readonly clock: LimiterClock;
    readonly emit: (event: VerifyEvent) => void;
  },
  options: VerifierOptions,
): Verifier {
  const reads = options.reads ?? VERIFY_READS;
  const intervalMs = options.intervalMs ?? VERIFY_INTERVAL_MS;
  const addresses = new Map(options.wallets.map((w) => [w.index, w.address]));
  const order = options.wallets.map((w) => w.address);
  // Started now: the read goes out before any /order answer can arrive.
  const baseline = deps.read(order).then(
    (r) => ({
      slot: r.slot,
      amounts: new Map(order.map((a, i) => [a, r.amounts[i] ?? 0n])),
    }),
    () => null,
  );
  const selling = options.side === 'sell';
  const sol = selling ? deps.sol : undefined;
  const solBaseline =
    sol === undefined
      ? Promise.resolve(null)
      : sol(order).then(
          (amounts) => new Map(order.map((a, i) => [a, amounts[i] ?? 0n])),
          () => null,
        );
  const pending = new Set<Promise<void>>();

  const check = async (index: number, landedSlot: bigint | null, expected: bigint | null) => {
    let solChange: bigint | null = null;
    const emit = (status: VerifyStatus, observed: bigint | null): void => {
      deps.emit({
        kind: 'verify',
        ...(selling ? ({ side: 'sell' } as const) : {}),
        runId: options.runId,
        at: deps.clock.now(),
        index,
        status,
        expected,
        observed,
        ...(selling ? { solChange } : {}),
      });
    };
    const address = addresses.get(index);
    const base = await baseline;
    const before = address === undefined ? undefined : base?.amounts.get(address);
    // A baseline read at or after the landing slot may already contain the buy.
    if (
      address === undefined ||
      base === null ||
      before === undefined ||
      (landedSlot !== null && base.slot >= landedSlot)
    ) {
      emit('UNVERIFIABLE', null);
      return;
    }
    const solBefore = (await solBaseline)?.get(address);
    /** Growth of the token balance; for a sell, its fall. */
    let growth: bigint | null = null;
    for (let i = 0; i < reads; i++) {
      if (i > 0) await deps.clock.sleep(intervalMs);
      try {
        const now = (await deps.read([address])).amounts[0] ?? 0n;
        growth = selling ? before - now : now - before;
      } catch {
        continue;
      }
      if (sol !== undefined && solBefore !== undefined) {
        try {
          solChange = ((await sol([address]))[0] ?? 0n) - solBefore;
        } catch {
          solChange = null;
        }
      }
      const tokensSettled = expected === null ? growth > 0n : growth === expected;
      if (tokensSettled && (!selling || (solChange !== null && solChange > 0n))) break;
    }
    if (growth === null) emit('UNVERIFIABLE', null);
    else if (growth <= 0n) emit('NO_INCREASE', growth);
    // A sell is confirmed by both balances: without the SOL read it stays unconfirmed.
    else if (selling && solChange === null) emit('UNVERIFIABLE', growth);
    else if (selling && solChange !== null && solChange <= 0n) emit('MISMATCH', growth);
    else if (expected === null) emit('INCREASED', growth);
    else emit(growth === expected ? 'MATCH' : 'MISMATCH', growth);
  };

  return {
    confirmed(index, landedSlot, expected) {
      const p = check(index, landedSlot, expected)
        .catch(() => undefined)
        .finally(() => {
          pending.delete(p);
        });
      pending.add(p);
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
