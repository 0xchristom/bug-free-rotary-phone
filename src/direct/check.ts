/**
 * Checks before signing a direct Meteora DBC buy (BUNNDLY-48, D-062) or sell (BUNNDLY-63).
 * Unlike a Jupiter order, the transaction is built in this app from RPC data, so the check
 * reads every instruction: the wallet is the only signer and the fee payer, only the
 * programs of a DBC trade are called, and exactly one `swap2` ExactIn spends the ordered
 * amount between the wallet's own accounts with the order's minimum out (above 0).
 * - Buy: lamports from the wallet's wrapped SOL account into its token account, and exactly
 *   one System transfer moves the same lamports into that wrapped SOL account.
 * - Sell: tokens from the wallet's token account into its wrapped SOL account, which is
 *   closed back to the wallet; no System transfer at all.
 * Pure and keyless.
 */
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Transaction,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenAddress,
} from '../chain/tokens.ts';
import { SOL_MINT, type JupiterOrder } from '../jupiter/client.ts';
import type { CheckedOrder, OrderExpectation } from '../executor/order-check.ts';
import { DBC_PROGRAM_ADDRESS } from './meteora-dbc/accounts.ts';
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SWAP2_DISCRIMINATOR,
  WSOL_MINT,
} from './meteora-dbc/instructions.ts';

export type DirectCheckProblem =
  | 'NO_TRANSACTION'
  | 'TAKER_MISMATCH'
  | 'INPUT_MINT_MISMATCH'
  | 'OUTPUT_MINT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'OVER_MAX_SPEND'
  | 'UNDECODABLE'
  | 'NOT_V0'
  /** Anyone but the wallet must sign, or the wallet does not pay the fee. */
  | 'SIGNER_MISMATCH'
  | 'TAKER_ALREADY_SIGNED'
  /** A program outside the DBC buy (ComputeBudget, System, Token, Token-2022, ATA, DBC). */
  | 'PROGRAM_NOT_ALLOWED'
  /** Not exactly one `swap2`, or another DBC instruction. */
  | 'SWAP_MISMATCH'
  /** Not exactly one SOL transfer of the amount into the wallet's wrapped SOL account. */
  | 'TRANSFER_MISMATCH'
  | 'NO_MINIMUM_OUT'
  /** The `swap2` minimum differs from the order's (the slippage limit, BUNNDLY-58). */
  | 'MINIMUM_OUT_MISMATCH'
  | 'PRIORITY_FEE_TOO_HIGH';

export const DIRECT_CHECK_MESSAGES: Record<DirectCheckProblem, string> = {
  NO_TRANSACTION: 'The direct route built no transaction to sign.',
  TAKER_MISMATCH: 'The transaction is for another wallet. It was not signed.',
  INPUT_MINT_MISMATCH:
    'The transaction does not spend what was ordered (SOL for a buy, the token for a sell). It was not signed.',
  OUTPUT_MINT_MISMATCH:
    'The transaction does not give what was ordered (the token for a buy, SOL for a sell). It was not signed.',
  AMOUNT_MISMATCH: 'The amount in the transaction differs from the ordered one. It was not signed.',
  OVER_MAX_SPEND:
    "The amount in the transaction is above the wallet's max spend. It was not signed.",
  UNDECODABLE: 'The transaction cannot be decoded. It was not signed.',
  NOT_V0: 'Unsupported transaction version (v0 expected). It was not signed.',
  SIGNER_MISMATCH: 'The wallet must be the only signer and the fee payer. It was not signed.',
  TAKER_ALREADY_SIGNED: "The wallet's signature slot is not empty. The transaction was not signed.",
  PROGRAM_NOT_ALLOWED: 'The transaction calls a program outside a DBC trade. It was not signed.',
  SWAP_MISMATCH: 'The transaction is not one DBC trade of the ordered token. It was not signed.',
  TRANSFER_MISMATCH: 'The SOL moved by the transaction differs from the order. It was not signed.',
  NO_MINIMUM_OUT: 'The transaction has no minimum amount out. It was not signed.',
  MINIMUM_OUT_MISMATCH:
    'The minimum amount out in the transaction differs from the order. It was not signed.',
  PRIORITY_FEE_TOO_HIGH: 'The priority fee is above 0.001 SOL. It was not signed.',
};

const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set([
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  DBC_PROGRAM_ADDRESS,
]);

/** `swap2` accounts (IDL order, `instructions.ts`): base mint 7, payer 9. */
const SWAP_BASE_MINT = 7;
const SWAP_QUOTE_MINT = 8;
const SWAP_PAYER = 9;
const SWAP_INPUT_ACCOUNT = 3;
const SWAP_OUTPUT_ACCOUNT = 4;
const SWAP_BASE_TOKEN_PROGRAM = 10;
/** System `Transfer` = 2, then u64 lamports. */
const SYSTEM_TRANSFER = 2;
/** ComputeBudget: SetComputeUnitLimit = 2 (u32), SetComputeUnitPrice = 3 (u64 micro-lamports). */
const COMPUTE_UNIT_LIMIT = 2;
const COMPUTE_UNIT_PRICE = 3;
const MAX_UNITS = 1_400_000n;
/** At most 0.001 SOL of priority fee per buy; the route asks for 0.000002 (D-062). */
export const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/** ATA `CreateIdempotent` = 1; Token `CloseAccount` = 9, `SyncNative` = 17. */
const ATA_CREATE_IDEMPOTENT = 1;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_SYNC_NATIVE = 17;

export type DirectCheckResult =
  | { readonly ok: true; readonly checked: CheckedOrder }
  | { readonly ok: false; readonly problem: DirectCheckProblem };

function fail(problem: DirectCheckProblem): DirectCheckResult {
  return { ok: false, problem };
}

function u64At(data: ArrayLike<number>, at: number): bigint | null {
  if (data.length < at + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[at + i] ?? 0);
  return v;
}

function startsWith(data: ArrayLike<number>, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => data[i] === b);
}

export async function checkDirectTransaction(
  order: JupiterOrder,
  expected: OrderExpectation,
): Promise<DirectCheckResult> {
  if (order.transaction === null) return fail('NO_TRANSACTION');
  if (order.taker !== expected.taker) return fail('TAKER_MISMATCH');
  const selling = expected.inputMint !== undefined;
  // The token the curve trades: bought for SOL, or sold for SOL.
  const mint = expected.inputMint ?? expected.outputMint;
  if (order.inputMint !== (expected.inputMint ?? SOL_MINT)) return fail('INPUT_MINT_MISMATCH');
  if (order.outputMint !== expected.outputMint || (selling && order.outputMint !== SOL_MINT)) {
    return fail('OUTPUT_MINT_MISMATCH');
  }
  if (order.inAmount > expected.maxSpend) return fail('OVER_MAX_SPEND');
  if (order.inAmount !== expected.amount) return fail('AMOUNT_MISMATCH');

  let transaction: Transaction;
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>['decode']>;
  try {
    transaction = getTransactionDecoder().decode(getBase64Encoder().encode(order.transaction));
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch {
    return fail('UNDECODABLE');
  }
  if (message.version !== 0) return fail('NOT_V0');
  // Address lookup tables would hide accounts from this check: none are built here.
  if ((message.addressTableLookups ?? []).length > 0) return fail('UNDECODABLE');
  const keys = message.staticAccounts;
  const signers = keys.slice(0, message.header.numSignerAccounts);
  if (signers.length !== 1 || signers[0] !== expected.taker) return fail('SIGNER_MISMATCH');
  if (Object.keys(transaction.signatures).length !== 1) return fail('UNDECODABLE');
  if ((transaction.signatures as Record<string, unknown>)[expected.taker] !== null) {
    return fail('TAKER_ALREADY_SIGNED');
  }

  const wsolAccount = await findAssociatedTokenAddress(expected.taker, WSOL_MINT, 'spl-token');
  let swaps = 0;
  let transfers = 0;
  let unitLimit: bigint | null = null;
  let unitPrice = 0n;
  for (const ix of message.instructions) {
    const program = keys[ix.programAddressIndex];
    if (program === undefined || !ALLOWED_PROGRAMS.has(program)) {
      return fail('PROGRAM_NOT_ALLOWED');
    }
    const data = ix.data ?? new Uint8Array();
    const account = (n: number): string | undefined => {
      const at = ix.accountIndices?.[n];
      return at === undefined ? undefined : keys[at];
    };
    if (program === DBC_PROGRAM_ADDRESS) {
      if (!startsWith(data, SWAP2_DISCRIMINATOR)) return fail('SWAP_MISMATCH');
      swaps += 1;
      const tokenProgram = account(SWAP_BASE_TOKEN_PROGRAM);
      if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
        return fail('SWAP_MISMATCH');
      }
      // Both ends are the wallet's own accounts, so nothing goes to anyone else.
      const tokenAccount = await findAssociatedTokenAddress(
        expected.taker,
        mint,
        tokenProgram === TOKEN_PROGRAM_ADDRESS ? 'spl-token' : 'token-2022',
      );
      if (
        account(SWAP_BASE_MINT) !== mint ||
        account(SWAP_QUOTE_MINT) !== WSOL_MINT ||
        account(SWAP_PAYER) !== expected.taker ||
        account(SWAP_INPUT_ACCOUNT) !== (selling ? tokenAccount : wsolAccount) ||
        account(SWAP_OUTPUT_ACCOUNT) !== (selling ? wsolAccount : tokenAccount) ||
        data[24] !== 0 // ExactIn
      ) {
        return fail('SWAP_MISMATCH');
      }
      if (u64At(data, 8) !== expected.amount) return fail('AMOUNT_MISMATCH');
      const minimumOut = u64At(data, 16);
      if (minimumOut === null || minimumOut <= 0n) return fail('NO_MINIMUM_OUT');
      if (minimumOut !== order.otherAmountThreshold) return fail('MINIMUM_OUT_MISMATCH');
    } else if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      if (data[0] === COMPUTE_UNIT_LIMIT && data.length === 5) {
        unitLimit = BigInt(data[1] ?? 0) | (BigInt(data[2] ?? 0) << 8n);
        unitLimit |= (BigInt(data[3] ?? 0) << 16n) | (BigInt(data[4] ?? 0) << 24n);
      } else if (data[0] === COMPUTE_UNIT_PRICE && data.length === 9) {
        unitPrice = u64At(data, 1) ?? 0n;
      } else return fail('PROGRAM_NOT_ALLOWED');
    } else if (program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      // CreateIdempotent only: the wallet's own wrapped SOL and token accounts.
      if (data.length !== 1 || data[0] !== ATA_CREATE_IDEMPOTENT) {
        return fail('PROGRAM_NOT_ALLOWED');
      }
      if (account(0) !== expected.taker || account(2) !== expected.taker) {
        return fail('SIGNER_MISMATCH');
      }
    } else if (program === TOKEN_PROGRAM_ADDRESS || program === TOKEN_2022_PROGRAM_ADDRESS) {
      // SyncNative and CloseAccount of the wrapped SOL account back to the wallet only.
      if (data.length !== 1 || account(0) !== wsolAccount) return fail('PROGRAM_NOT_ALLOWED');
      if (data[0] === TOKEN_CLOSE_ACCOUNT) {
        if (account(1) !== expected.taker || account(2) !== expected.taker) {
          return fail('TRANSFER_MISMATCH');
        }
      } else if (data[0] !== TOKEN_SYNC_NATIVE) return fail('PROGRAM_NOT_ALLOWED');
    } else if (program === SYSTEM_PROGRAM_ADDRESS) {
      // Only the one transfer into the wrapped SOL account; ATA creation calls System
      // through the ATA program, not from the top level.
      if (data[0] !== SYSTEM_TRANSFER || data.length !== 12) return fail('TRANSFER_MISMATCH');
      transfers += 1;
      if (
        account(0) !== expected.taker ||
        account(1) !== wsolAccount ||
        u64At(data, 4) !== expected.amount
      ) {
        return fail('TRANSFER_MISMATCH');
      }
    }
  }
  if (swaps !== 1) return fail('SWAP_MISMATCH');
  // A sell moves no lamports of its own: the SOL comes out of the curve.
  if (transfers !== (selling ? 0 : 1)) return fail('TRANSFER_MISMATCH');
  // Without a limit the runtime allows up to 1.4M units per transaction.
  if ((unitLimit ?? MAX_UNITS) * unitPrice > MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n) {
    return fail('PRIORITY_FEE_TOO_HIGH');
  }
  return { ok: true, checked: { taker: expected.taker, transaction, takerPaysFee: true } };
}
