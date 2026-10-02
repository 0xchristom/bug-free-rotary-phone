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
 */
import type { LimiterClock } from './limiter.ts';

/** Token balances (raw u64) of the given owners, in order, with the slot they were read at. */
export type TokenReader = (
  owners: readonly string[],
) => Promise<{ readonly amounts: readonly bigint[]; readonly slot: bigint }>;

export type VerifyStatus =
  /** Grew by exactly `totalOutputAmount`. */
  | 'MATCH'
  /** Grew, and no expected amount was known (confirmed from the chain check). */
  | 'INCREASED'
  /** Grew by a different amount (e.g. someone else sent tokens). */
  | 'MISMATCH'
  /** Did not grow after every re-read. */
  | 'NO_INCREASE'
  /** No usable baseline or no balance read (RPC errors). */
  | 'UNVERIFIABLE';

export const VERIFY_MESSAGES: Record<VerifyStatus, string> = {
  MATCH: 'Potwierdzone w łańcuchu: saldo tokenu wzrosło o kupioną ilość.',
  INCREASED: 'Saldo tokenu wzrosło (ilości z Jupitera brak, więc bez porównania).',
  MISMATCH: 'Ostrzeżenie: saldo tokenu wzrosło o inną ilość, niż podał Jupiter.',
  NO_INCREASE: 'Ostrzeżenie: saldo tokenu nie wzrosło po zakupie.',
  UNVERIFIABLE: 'Nie udało się potwierdzić zakupu odczytem salda tokenu.',
};

export interface VerifyEvent {
  readonly kind: 'verify';
  readonly runId: number;
  readonly at: number;
  readonly index: number;
  readonly status: VerifyStatus;
  /** `totalOutputAmount`, when known. */
  readonly expected: bigint | null;
  /** Growth seen on the chain, when read. */
  readonly observed: bigint | null;
}

export interface VerifyWallet {
  readonly index: number;
  readonly address: string;
}

export interface VerifierOptions {
  readonly runId: number;
  readonly wallets: readonly VerifyWallet[];
  /** Balance reads after CONFIRMED, `intervalMs` apart. */
  readonly reads?: number;
  readonly intervalMs?: number;
}

export const VERIFY_READS = 5;
export const VERIFY_INTERVAL_MS = 2_000;

export interface Verifier {
  /** Starts the check of one confirmed wallet. Never throws. */
  confirmed(index: number, landedSlot: bigint | null, expected: bigint | null): void;
  /** Resolves when every started check has emitted its event. */
  idle(): Promise<void>;
}

export function createVerifier(
  deps: {
    readonly read: TokenReader;
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
  const pending = new Set<Promise<void>>();

  const check = async (index: number, landedSlot: bigint | null, expected: bigint | null) => {
    const emit = (status: VerifyStatus, observed: bigint | null): void => {
      deps.emit({
        kind: 'verify',
        runId: options.runId,
        at: deps.clock.now(),
        index,
        status,
        expected,
        observed,
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
    let growth: bigint | null = null;
    for (let i = 0; i < reads; i++) {
      if (i > 0) await deps.clock.sleep(intervalMs);
      try {
        const now = await deps.read([address]);
        growth = (now.amounts[0] ?? 0n) - before;
      } catch {
        continue;
      }
      if (expected === null ? growth > 0n : growth === expected) break;
    }
    if (growth === null) emit('UNVERIFIABLE', null);
    else if (growth <= 0n) emit('NO_INCREASE', growth);
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
