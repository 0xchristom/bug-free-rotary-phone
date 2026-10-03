/**
 * RPC reads of mode B (BUNNDLY-34, D-038): the creator's signatures for the gap catch-up
 * (D-036) and the full transaction for the slow detector path (D-037). Errors carry no
 * URL (the transport turns them into RPC_UNAVAILABLE).
 */
import {
  address,
  createSolanaRpcFromTransport,
  signature as toSignature,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  type Rpc,
  type RpcTransport,
} from '@solana/kit';
import type { TransactionReader } from '../watcher/detectors/detector.ts';
import type { SignatureReader } from '../watcher/stream.ts';

export type WatchRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>;

export function createWatchRpc(transport: RpcTransport): WatchRpc {
  return createSolanaRpcFromTransport(transport);
}

/** `getSignaturesForAddress` of the creator, `confirmed`, newest first. */
export function signatureReader(rpc: WatchRpc, creator: string): SignatureReader {
  const owner = address(creator);
  return async (options) => {
    const list = await rpc
      .getSignaturesForAddress(owner, {
        limit: options.limit,
        commitment: 'confirmed',
        ...(options.until === undefined ? {} : { until: toSignature(options.until) }),
        ...(options.before === undefined ? {} : { before: toSignature(options.before) }),
      })
      .send();
    return list.map((e) => ({ signature: e.signature, err: e.err, blockTime: e.blockTime }));
  };
}

/**
 * `getTransaction` as the detectors read it: `json`, `confirmed`, v1 (LaunchLab creates
 * are v1, D-037). Null while the transaction is not visible yet.
 */
export function transactionReader(rpc: WatchRpc): TransactionReader {
  return (sig) =>
    rpc
      .getTransaction(toSignature(sig), {
        encoding: 'json',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 1,
      })
      .send();
}
