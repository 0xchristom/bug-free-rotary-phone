/**
 * Chain check before a retry (BUNNDLY-23, D-030): did a transaction sent to `/execute`
 * land, and if not, can it still land?
 *
 * - Known signature (the taker pays the fee, or `/execute` returned it):
 *   `getSignatureStatuses` with history.
 * - Unknown signature (JupiterZ / gasless: the market maker or a sponsor pays, and its
 *   signature is the transaction's id): `getSignaturesForAddress` of the taker since the
 *   send, then `getTransaction` of each candidate; ours is the one that carries the
 *   taker's own signature, which we made. Exact, so a token deposit from someone else
 *   cannot be mistaken for our buy.
 * - Expired: block height above `lastValidBlockHeight` (aggregator), or, without one, the
 *   transaction's blockhash no longer valid and the RFQ `expireAt` passed. Expiry is read
 *   before the lookup, so a transaction that landed just before expiry is always seen.
 *
 * Anything unclear is `pending`: the executor keeps checking and never retries on doubt.
 * Errors carry no URL (the RPC transport turns them into RPC_UNAVAILABLE).
 */
import {
  address,
  blockhash,
  createSolanaRpcFromTransport,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signature as toSignature,
  type GetBlockHeightApi,
  type GetSignatureStatusesApi,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  type IsBlockhashValidApi,
  type Rpc,
  type RpcTransport,
} from '@solana/kit';
import type { Landing, LandingChecker, LandingQuery } from '../executor/landing.ts';

export type LandingRpc = Rpc<
  GetBlockHeightApi &
    GetSignatureStatusesApi &
    GetSignaturesForAddressApi &
    GetTransactionApi &
    IsBlockhashValidApi
>;

export function createLandingRpc(transport: RpcTransport): LandingRpc {
  return createSolanaRpcFromTransport(transport);
}

/** Candidates read per check; a fresh fleet wallet has only a few transactions. */
export const SIGNATURES_LIMIT = 25;
/** Clock skew allowance when comparing block times with the send time. */
export const BLOCK_TIME_MARGIN_MS = 120_000;

interface Decoded {
  readonly blockhash: string;
  /** First signature (the transaction id), null while that slot is empty. */
  readonly firstSignature: string | null;
  /** The taker's own signature. */
  readonly takerSignature: string | null;
}

function decode(base64: string, taker: string): Decoded {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const base58 = getBase58Decoder();
  const signatures = transaction.signatures as Record<string, Uint8Array | null>;
  const first = message.staticAccounts[0];
  const firstBytes = first === undefined ? null : (signatures[first] ?? null);
  const takerBytes = signatures[taker] ?? null;
  return {
    blockhash: message.lifetimeToken,
    firstSignature: firstBytes === null ? null : base58.decode(firstBytes),
    takerSignature: takerBytes === null ? null : base58.decode(takerBytes),
  };
}

/** Signatures of a base64 wire transaction, as base58 strings. */
function signaturesOf(base64: string): string[] {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const base58 = getBase58Decoder();
  return Object.values(transaction.signatures as Record<string, Uint8Array | null>)
    .filter((s): s is Uint8Array => s !== null)
    .map((s) => base58.decode(s));
}

export interface LandingCheckerOptions {
  readonly now: () => number;
}

export function createLandingChecker(
  rpc: LandingRpc,
  options: LandingCheckerOptions,
): LandingChecker {
  const expired = async (query: LandingQuery, decoded: Decoded): Promise<boolean> => {
    if (query.lastValidBlockHeight !== null) {
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
      return height > query.lastValidBlockHeight;
    }
    if (query.expireAt !== null && options.now() <= query.expireAt * 1000) return false;
    const { value } = await rpc
      .isBlockhashValid(blockhash(decoded.blockhash), { commitment: 'confirmed' })
      .send();
    return !value;
  };

  const byStatus = async (sig: string): Promise<Landing | null> => {
    const { value } = await rpc
      .getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true })
      .send();
    const status = value[0] ?? null;
    if (status === null) return null;
    if (status.confirmationStatus === 'processed') return { status: 'pending' };
    return status.err === null
      ? { status: 'landed', signature: sig, slot: status.slot }
      : { status: 'failed', signature: sig };
  };

  const byTaker = async (query: LandingQuery, takerSignature: string): Promise<Landing | null> => {
    const entries = await rpc
      .getSignaturesForAddress(address(query.taker), {
        limit: SIGNATURES_LIMIT,
        commitment: 'confirmed',
      })
      .send();
    const since = query.sentAtMs - BLOCK_TIME_MARGIN_MS;
    const recent = entries.filter(
      (e) => e.blockTime === null || Number(e.blockTime) * 1000 >= since,
    );
    for (const entry of recent) {
      if (entry.signature === takerSignature) {
        return entry.err === null
          ? { status: 'landed', signature: entry.signature, slot: entry.slot }
          : { status: 'failed', signature: entry.signature };
      }
      const tx = await rpc
        .getTransaction(entry.signature, {
          encoding: 'base64',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
        .send();
      // Not visible yet at this commitment: decide on a later check.
      if (tx === null) return { status: 'pending' };
      if (!signaturesOf(tx.transaction[0]).includes(takerSignature)) continue;
      return tx.meta?.err === null
        ? { status: 'landed', signature: entry.signature, slot: tx.slot }
        : { status: 'failed', signature: entry.signature };
    }
    // Every entry is newer than the send: older ones were cut off, ours could be there.
    if (recent.length === SIGNATURES_LIMIT) return { status: 'pending' };
    return null;
  };

  return async (query) => {
    const decoded = decode(query.signedTransaction, query.taker);
    // Read expiry first: if it has expired, a transaction that landed is already visible.
    const isExpired = await expired(query, decoded);
    const known = query.signature ?? decoded.firstSignature;
    let found: Landing | null;
    if (known !== null) {
      found = await byStatus(known);
    } else if (decoded.takerSignature !== null) {
      found = await byTaker(query, decoded.takerSignature);
    } else {
      // Unsigned by the taker: it could never have landed.
      return { status: 'expired' };
    }
    if (found !== null) return found;
    return isExpired ? { status: 'expired' } : { status: 'pending' };
  };
}
