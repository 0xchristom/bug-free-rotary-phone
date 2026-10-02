/**
 * Fake chain for executor tests (BUNNDLY-23): transactions land at a given time, only
 * before their expiry, and the landing checker sees exactly what is on it. Blocks come
 * every 400 ms on the fake clock.
 *
 * The rule it models: a transaction can land only while its blockhash is valid (aggregator:
 * block height ≤ lastValidBlockHeight; RFQ: until a minute after `expireAt`). Once the
 * checker says `expired`, anything that landed is already visible.
 */
import type { Landing, LandingQuery } from '../../src/executor/landing.ts';
import type { FakeClock } from './fake-clock.ts';
import { T0 } from './fake-clock.ts';

export const SLOT_MS = 400;
export const H0 = 400_000_000n;
/** Blockhash life of an RFQ transaction after the quote's `expireAt`. */
export const RFQ_GRACE_MS = 60_000;

export interface Expiry {
  readonly lastValidBlockHeight: bigint | null;
  readonly expireAt: number | null;
}

export interface Landed {
  readonly taker: string;
  readonly signedTransaction: string;
  readonly signature: string;
  readonly ok: boolean;
  readonly at: number;
  /** Lamports the swap took (0 when it failed on the chain). */
  readonly spent: bigint;
  /** Tokens it put in the taker's account (0 when it failed). */
  readonly received: bigint;
}

export class FakeChain {
  readonly landed: Landed[] = [];
  /** Landings refused because the transaction had expired. */
  dropped = 0;
  /** Checker calls, for tests that count RPC use. */
  checks = 0;

  constructor(private readonly clock: FakeClock) {}

  height(at = this.clock.now()): bigint {
    return H0 + BigInt(Math.floor((at - T0) / SLOT_MS));
  }

  /** First moment the transaction can no longer land. */
  deadline(expiry: Expiry): number {
    if (expiry.lastValidBlockHeight !== null) {
      return T0 + Number(expiry.lastValidBlockHeight - H0 + 1n) * SLOT_MS;
    }
    if (expiry.expireAt !== null) return expiry.expireAt * 1000 + RFQ_GRACE_MS;
    return Number.POSITIVE_INFINITY;
  }

  /** Puts a transaction on the chain at `at`, unless it has expired by then. */
  land(tx: Omit<Landed, 'at'> & Expiry & { readonly at: number }): boolean {
    if (tx.at >= this.deadline(tx)) {
      this.dropped += 1;
      return false;
    }
    // The same bytes land once, like on the real chain.
    if (this.landed.some((l) => l.signedTransaction === tx.signedTransaction)) return false;
    this.landed.push({
      taker: tx.taker,
      signedTransaction: tx.signedTransaction,
      signature: tx.signature,
      ok: tx.ok,
      at: tx.at,
      spent: tx.ok ? tx.spent : 0n,
      received: tx.ok ? tx.received : 0n,
    });
    return true;
  }

  visible(): Landed[] {
    const now = this.clock.now();
    return this.landed.filter((l) => l.at <= now);
  }

  successfulBuys(taker: string): Landed[] {
    return this.landed.filter((l) => l.taker === taker && l.ok);
  }

  /** Token balances as an RPC would read them now (BUNNDLY-25), plus external deposits. */
  readonly deposits = new Map<string, bigint>();
  readonly tokens = (owners: readonly string[]) => {
    const visible = this.visible();
    return Promise.resolve({
      amounts: owners.map(
        (o) =>
          (this.deposits.get(o) ?? 0n) +
          visible.filter((l) => l.taker === o).reduce((sum, l) => sum + l.received, 0n),
      ),
      slot: this.height(),
    });
  };

  readonly checker = (query: LandingQuery): Promise<Landing> => {
    this.checks += 1;
    const found = this.visible().find((l) => l.signedTransaction === query.signedTransaction);
    if (found) {
      return Promise.resolve(
        found.ok
          ? { status: 'landed', signature: found.signature, slot: this.height(found.at) }
          : { status: 'failed', signature: found.signature },
      );
    }
    const expired = this.clock.now() >= this.deadline(query);
    return Promise.resolve(expired ? { status: 'expired' } : { status: 'pending' });
  };
}
