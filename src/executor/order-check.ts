/**
 * Checks before signing (BUNNDLY-22, D-028): is this `/order` transaction the one the
 * executor asked for, for this wallet? Pure and keyless, so it also runs on real
 * transactions without any key (BUNNDLY-30 part B). The vault signs only after it passes.
 *
 * Trust boundary: Jupiter's API (HTTPS to api.jup.ag) is trusted. These checks catch
 * mistakes (another wallet, another order, damaged data), not a malicious Jupiter: they do
 * not interpret the instructions of the swap.
 */
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Transaction,
} from '@solana/kit';
import { SOL_MINT, type JupiterOrder } from '../jupiter/client.ts';

/** What the executor asked `/order` for, for one wallet. */
export interface OrderExpectation {
  /** The wallet's address. */
  readonly taker: string;
  readonly outputMint: string;
  /** Lamports asked for. */
  readonly amount: bigint;
  /** The wallet's max spend; inAmount may not exceed it. */
  readonly maxSpend: bigint;
}

export type OrderCheckProblem =
  /** `/order` gave no transaction (no taker, or `transaction: ""`). */
  | 'NO_TRANSACTION'
  | 'TAKER_MISMATCH'
  | 'INPUT_MINT_MISMATCH'
  | 'OUTPUT_MINT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'OVER_MAX_SPEND'
  /** The bytes are not a transaction. */
  | 'UNDECODABLE'
  /** Legacy or a newer version: only v0 is accepted. */
  | 'NOT_V0'
  /** More than 2 required signatures (taker plus market maker or gas sponsor). */
  | 'TOO_MANY_SIGNERS'
  | 'TAKER_NOT_SIGNER'
  | 'TAKER_ALREADY_SIGNED'
  /** The first account (fee payer) is not `signatureFeePayer` (or the taker). */
  | 'FEE_PAYER_MISMATCH';

export const ORDER_CHECK_MESSAGES: Record<OrderCheckProblem, string> = {
  NO_TRANSACTION: 'Jupiter returned no transaction to sign.',
  TAKER_MISMATCH: 'The transaction is for another wallet. It was not signed.',
  INPUT_MINT_MISMATCH: 'The transaction does not pay in SOL. It was not signed.',
  OUTPUT_MINT_MISMATCH: 'The transaction buys a different token than ordered. It was not signed.',
  AMOUNT_MISMATCH: 'The amount in the transaction differs from the ordered one. It was not signed.',
  OVER_MAX_SPEND:
    "The amount in the transaction is above the wallet's max spend. It was not signed.",
  UNDECODABLE: 'The transaction cannot be decoded. It was not signed.',
  NOT_V0: 'Unsupported transaction version (v0 expected). It was not signed.',
  TOO_MANY_SIGNERS: 'The transaction needs more than 2 signatures. It was not signed.',
  TAKER_NOT_SIGNER: 'The wallet is not a signer of the transaction. It was not signed.',
  TAKER_ALREADY_SIGNED: "The wallet's signature slot is not empty. The transaction was not signed.",
  FEE_PAYER_MISMATCH:
    "The fee payer in the transaction does not match Jupiter's answer. It was not signed.",
};

export const MAX_ORDER_SIGNERS = 2;

/** A transaction that passed the checks, decoded and ready for the taker's signature. */
export interface CheckedOrder {
  readonly taker: string;
  readonly transaction: Transaction;
  /** The taker is the fee payer: its signature is the transaction signature. */
  readonly takerPaysFee: boolean;
}

export type OrderCheckResult =
  | { readonly ok: true; readonly checked: CheckedOrder }
  | { readonly ok: false; readonly problem: OrderCheckProblem };

function fail(problem: OrderCheckProblem): OrderCheckResult {
  return { ok: false, problem };
}

export function checkOrderTransaction(
  order: JupiterOrder,
  expected: OrderExpectation,
): OrderCheckResult {
  if (order.transaction === null) return fail('NO_TRANSACTION');
  if (order.taker !== expected.taker) return fail('TAKER_MISMATCH');
  if (order.inputMint !== SOL_MINT) return fail('INPUT_MINT_MISMATCH');
  if (order.outputMint !== expected.outputMint) return fail('OUTPUT_MINT_MISMATCH');
  if (order.inAmount > expected.maxSpend) return fail('OVER_MAX_SPEND');
  if (order.inAmount !== expected.amount) return fail('AMOUNT_MISMATCH');

  let transaction: Transaction;
  let version: unknown;
  let signers: readonly string[];
  let firstAccount: string | undefined;
  try {
    transaction = getTransactionDecoder().decode(getBase64Encoder().encode(order.transaction));
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    version = message.version;
    signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
    firstAccount = message.staticAccounts[0];
    if (Object.keys(transaction.signatures).length !== signers.length) return fail('UNDECODABLE');
  } catch {
    return fail('UNDECODABLE');
  }
  if (version !== 0) return fail('NOT_V0');
  if (signers.length > MAX_ORDER_SIGNERS) return fail('TOO_MANY_SIGNERS');
  if (!signers.includes(expected.taker)) return fail('TAKER_NOT_SIGNER');
  const slot = (transaction.signatures as Record<string, unknown>)[expected.taker];
  if (slot !== null) return fail('TAKER_ALREADY_SIGNED');
  if (firstAccount !== (order.signatureFeePayer ?? expected.taker)) {
    return fail('FEE_PAYER_MISMATCH');
  }
  return {
    ok: true,
    checked: { taker: expected.taker, transaction, takerPaysFee: firstAccount === expected.taker },
  };
}
