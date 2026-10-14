/**
 * What a pasted address is (BUNNDLY-59): a token mint to buy, or a wallet to watch for
 * new tokens. One getMultipleAccounts read of the account:
 *
 * - owned by SPL Token or Token-2022 and laid out as an initialized mint → mint;
 * - no account, or a System Program account without data → wallet (a creator signs with
 *   it; an address that has never held SOL has no account yet);
 * - a token account, an executable program, anything else → an error that names it.
 *
 * Layouts and program ids: see tokens.ts (D-021).
 */
import { base64 } from '@scure/base';
import { address } from '@solana/kit';
import { AppError } from '../core/errors.ts';
import type { BalancesRpc } from './balances.ts';
import {
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM_ADDRESS,
  parseMint,
  type TokenProgram,
} from './tokens.ts';

export type TargetKind =
  { readonly kind: 'mint'; readonly program: TokenProgram } | { readonly kind: 'wallet' };

/** The fields of an RPC account that decide the kind. */
export interface TargetAccount {
  readonly owner: string;
  readonly executable: boolean;
  readonly data: Uint8Array;
}

/** Token-2022: account type byte after the 165-byte base (2 = token account). */
const ACCOUNT_TYPE_TOKEN_ACCOUNT = 2;

function isTokenAccount(owner: string, data: Uint8Array): boolean {
  if (data.length === TOKEN_ACCOUNT_SIZE) return true;
  return (
    owner === TOKEN_2022_PROGRAM_ADDRESS &&
    data.length > TOKEN_ACCOUNT_SIZE &&
    data[TOKEN_ACCOUNT_SIZE] === ACCOUNT_TYPE_TOKEN_ACCOUNT
  );
}

/** Kind of an account read from the chain; `null` is an address without an account. */
export function classifyAccount(account: TargetAccount | null): TargetKind {
  if (account === null) return { kind: 'wallet' };
  const { owner, data } = account;
  if (account.executable) throw new AppError('TARGET_IS_PROGRAM');
  if (owner === SYSTEM_PROGRAM_ADDRESS) {
    // A System account with data is a nonce account: nobody creates tokens with it.
    if (data.length === 0) return { kind: 'wallet' };
    throw new AppError('TARGET_UNSUPPORTED');
  }
  if (owner === TOKEN_PROGRAM_ADDRESS || owner === TOKEN_2022_PROGRAM_ADDRESS) {
    try {
      return { kind: 'mint', program: parseMint(owner, data).program };
    } catch {
      if (isTokenAccount(owner, data)) throw new AppError('TARGET_IS_TOKEN_ACCOUNT');
      throw new AppError('TARGET_UNSUPPORTED');
    }
  }
  throw new AppError('TARGET_UNSUPPORTED');
}

/** A Solana address: base58 of 32 bytes. Anything else is INVALID_TARGET_ADDRESS. */
export function parseTargetAddress(text: string): string {
  try {
    return address(text.trim());
  } catch {
    throw new AppError('INVALID_TARGET_ADDRESS');
  }
}

/** Reads the account and tells its kind. Network failures are left to the caller. */
export async function fetchTarget(rpc: BalancesRpc, target: string): Promise<TargetKind> {
  const { value } = await rpc
    .getMultipleAccounts([address(target)], { encoding: 'base64', commitment: 'confirmed' })
    .send();
  const account = value[0];
  if (!account) return classifyAccount(null);
  const raw: unknown = account.data;
  if (!Array.isArray(raw) || typeof raw[0] !== 'string' || raw[1] !== 'base64') {
    throw new Error('expected base64 account data');
  }
  return classifyAccount({
    owner: account.owner,
    executable: account.executable,
    data: base64.decode(raw[0]),
  });
}
