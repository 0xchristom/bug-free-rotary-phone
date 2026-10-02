/**
 * Did a sent transaction land? (BUNNDLY-23, D-030.) The executor asks this before any
 * retry of a wallet whose transaction may have been sent. The answer comes from the
 * chain (`src/chain/landing.ts`); tests use a fake chain.
 */

export interface LandingQuery {
  readonly taker: string;
  /** The signed transaction as sent to `/execute` (base64). Stays in the worker. */
  readonly signedTransaction: string;
  /** Transaction signature when known (the taker pays the fee, or `/execute` returned it). */
  readonly signature: string | null;
  /** Aggregator orders: the transaction cannot land above this block height. */
  readonly lastValidBlockHeight: bigint | null;
  /** RFQ orders: quote expiry, Unix seconds. */
  readonly expireAt: number | null;
  /** When `/execute` was called (Unix ms). */
  readonly sentAtMs: number;
}

export type Landing =
  /** Landed and succeeded: the wallet bought. */
  | { readonly status: 'landed'; readonly signature: string; readonly slot: bigint | null }
  /** Landed with an error (e.g. slippage): final, nothing bought, a retry is safe. */
  | { readonly status: 'failed'; readonly signature: string }
  /** Not on the chain and can no longer land: a retry is safe. */
  | { readonly status: 'expired' }
  /** Not known yet (not visible, not expired, or the RPC did not answer). */
  | { readonly status: 'pending' };

/** May throw; the executor treats a throw as `pending`. */
export type LandingChecker = (query: LandingQuery) => Promise<Landing>;

/** Time between chain checks of one wallet. */
export const LANDING_POLL_MS = 2_000;
/**
 * Give up checking after this long: the wallet stays UNKNOWN for good and is never
 * retried. Well above a blockhash's life (~60–90 s), so a healthy RPC always decides.
 */
export const LANDING_TIMEOUT_MS = 180_000;
