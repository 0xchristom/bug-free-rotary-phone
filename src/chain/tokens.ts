/**
 * Token balances of the fleet (SPEC 3.2): the mint account tells the token program
 * (SPL Token or Token-2022) and the decimals; every wallet's associated token account
 * (ATA) for that program is read in batches. A missing ATA is a balance of 0.
 *
 * Layouts follow the SPL Token docs: Mint = 82 bytes (decimals at 44, is_initialized at
 * 45), token account = 165 bytes (mint 0..32, owner 32..64, amount u64 LE at 64..72).
 * Token-2022 keeps the same base layout and appends extensions after byte 165, preceded
 * by an account type byte (1 = Mint, 2 = Account), so amounts are read from the base
 * part only. Program addresses are constants from the official docs (D-021):
 * https://spl.solana.com/token, https://spl.solana.com/token-2022,
 * https://spl.solana.com/associated-token-account
 */
import { base64 } from '@scure/base';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { AppError } from '../core/errors.ts';
import { MAX_ACCOUNTS_PER_CALL, chunk, type BalancesRpc } from './balances.ts';

/** https://spl.solana.com/token (program id). */
export const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** https://spl.solana.com/token-2022 (program id). */
export const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** https://spl.solana.com/associated-token-account (program id). */
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** System Program id, official repository: https://github.com/solana-program/system */
export const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';

export type TokenProgram = 'spl-token' | 'token-2022';

const PROGRAM_BY_OWNER: Readonly<Record<string, TokenProgram>> = {
  [TOKEN_PROGRAM_ADDRESS]: 'spl-token',
  [TOKEN_2022_PROGRAM_ADDRESS]: 'token-2022',
};

export function programAddress(program: TokenProgram): string {
  return program === 'spl-token' ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;
}

export const MINT_SIZE = 82;
export const TOKEN_ACCOUNT_SIZE = 165;
const DECIMALS_OFFSET = 44;
const IS_INITIALIZED_OFFSET = 45;
const AMOUNT_OFFSET = 64;
/** Token-2022: account type byte right after the 165-byte base. */
const ACCOUNT_TYPE_OFFSET = TOKEN_ACCOUNT_SIZE;
const ACCOUNT_TYPE_MINT = 1;
/** mint (32) + owner (32) + amount (8): all we need from a token account. */
const TOKEN_ACCOUNT_PREFIX = AMOUNT_OFFSET + 8;

export interface MintInfo {
  readonly program: TokenProgram;
  readonly decimals: number;
}

function notAMint(): never {
  throw new AppError('NOT_A_TOKEN_MINT');
}

/** Program and decimals from a mint account; anything else is NOT_A_TOKEN_MINT. */
export function parseMint(owner: string, data: Uint8Array): MintInfo {
  const program = PROGRAM_BY_OWNER[owner];
  if (program === undefined) return notAMint();
  const isPlainMint = data.length === MINT_SIZE;
  const isMintWithExtensions =
    program === 'token-2022' &&
    data.length > ACCOUNT_TYPE_OFFSET &&
    data[ACCOUNT_TYPE_OFFSET] === ACCOUNT_TYPE_MINT;
  if (!isPlainMint && !isMintWithExtensions) return notAMint();
  if (data[IS_INITIALIZED_OFFSET] !== 1) return notAMint();
  return { program, decimals: data[DECIMALS_OFFSET] ?? notAMint() };
}

/** u64 little-endian, exact (bigint). */
export function readU64LE(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) throw new Error('readU64LE: out of range');
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** ATA of `owner` for `mint` under the given token program. */
export async function findAssociatedTokenAddress(
  owner: string,
  mint: string,
  program: TokenProgram,
): Promise<string> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
    seeds: [
      encoder.encode(address(owner)),
      encoder.encode(address(programAddress(program))),
      encoder.encode(address(mint)),
    ],
  });
  return ata;
}

function decodeData(data: unknown): Uint8Array {
  if (!Array.isArray(data) || typeof data[0] !== 'string' || data[1] !== 'base64') {
    throw new Error('expected base64 account data');
  }
  return base64.decode(data[0]);
}

export interface TokenBalances extends MintInfo {
  readonly mint: string;
  /** Raw amounts (u64), same order as the owners. */
  readonly amounts: readonly bigint[];
  /** Lowest slot the ATA reads saw (BUNNDLY-25: before or after a buy landed). */
  readonly slot: bigint;
}

/** Reads the mint, then every owner's ATA in batches of at most 100. */
export async function fetchTokenBalances(
  rpc: BalancesRpc,
  mint: string,
  owners: readonly string[],
): Promise<TokenBalances> {
  let mintAddress;
  try {
    mintAddress = address(mint);
  } catch {
    return notAMint();
  }
  const { value: mintValue } = await rpc
    .getMultipleAccounts([mintAddress], { encoding: 'base64', commitment: 'confirmed' })
    .send();
  const mintAccount = mintValue[0];
  if (!mintAccount) return notAMint();
  const info = parseMint(mintAccount.owner, decodeData(mintAccount.data));
  const tokenProgram = programAddress(info.program);
  const mintBytes = getAddressEncoder().encode(mintAddress);

  const atas = await Promise.all(
    owners.map((o) => findAssociatedTokenAddress(o, mint, info.program)),
  );
  const amounts: bigint[] = [];
  let slot: bigint | null = null;
  for (const batch of chunk(atas, MAX_ACCOUNTS_PER_CALL)) {
    const { context, value } = await rpc
      .getMultipleAccounts(
        batch.map((a) => address(a)),
        {
          encoding: 'base64',
          dataSlice: { offset: 0, length: TOKEN_ACCOUNT_PREFIX },
          commitment: 'confirmed',
        },
      )
      .send();
    if (value.length !== batch.length) throw new Error('getMultipleAccounts: wrong length');
    slot = slot === null || context.slot < slot ? context.slot : slot;
    for (const account of value) {
      if (!account) {
        amounts.push(0n); // no ATA yet
        continue;
      }
      const data = decodeData(account.data);
      // Anyone can send SOL to an ATA address before the token account exists: it is then
      // a System Program account without data. The ATA program handles this when it creates
      // the account (program/src/tools/account.rs, `new_pda_account.lamports() > 0`), so it
      // is simply a balance of 0 (D-021).
      if (account.owner === SYSTEM_PROGRAM_ADDRESS && data.length === 0) {
        amounts.push(0n);
        continue;
      }
      // Any other account at an ATA address cannot happen; refuse it, but not as a
      // network error.
      if (
        account.owner !== tokenProgram ||
        data.length < TOKEN_ACCOUNT_PREFIX ||
        !sameBytes(data.subarray(0, 32), mintBytes)
      ) {
        throw new AppError('INTERNAL_ERROR');
      }
      amounts.push(readU64LE(data, AMOUNT_OFFSET));
    }
  }
  return { mint, ...info, amounts, slot: slot ?? 0n };
}
