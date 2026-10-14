/**
 * Meteora DBC buy quote for a mint (BUNNDLY-47, D-053): finds the pool, reads the pool and
 * its config, and returns either a quote or an explicit reason why there is none. Only
 * RPC reads; nothing is signed or sent here.
 *
 * Finding the pool: its PDA needs the config address, which a mint alone does not give, so
 * the pool is read with `getProgramAccounts` (size and `base_mint` filters) and then checked
 * against the PDA. Stage 2 takes the pool from the watcher's detection; this read is the
 * fallback (D-053).
 */
import {
  address,
  getAddressDecoder,
  type Base58EncodedBytes,
  type GetAccountInfoApi,
  type GetBlockTimeApi,
  type GetProgramAccountsApi,
  type GetSlotApi,
  type Rpc,
} from '@solana/kit';
import { base64 } from '@scure/base';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  type TokenProgram,
} from '../../chain/tokens.ts';
import {
  ActivationType,
  DBC_PROGRAM_ADDRESS,
  POOL_BASE_MINT_OFFSET,
  VIRTUAL_POOL_SIZE,
  decodePoolConfig,
  decodeVirtualPool,
  type PoolConfig,
  type VirtualPool,
} from './accounts.ts';
import { WSOL_MINT, findDbcPoolAddress } from './instructions.ts';
import { minimumAmountOut, quoteBuyExactIn, type BuyQuote } from './math.ts';

export type DbcRpc = Rpc<GetProgramAccountsApi & GetAccountInfoApi & GetSlotApi & GetBlockTimeApi>;

/**
 * Token-2022 mint extensions a plain DBC buy cannot handle (numbers: `ExtensionType` in
 * solana-program/token-2022 `interface/src/extension/mod.rs`): a transfer fee changes the
 * amount received, a transfer hook needs extra accounts, a default frozen state, a
 * non-transferable or a paused mint make the transfer fail.
 */
const UNSUPPORTED_EXTENSIONS: Readonly<Record<number, string>> = {
  1: 'transfer-fee',
  6: 'default-account-state',
  9: 'non-transferable',
  14: 'transfer-hook',
  26: 'pausable',
};
const MINT_ACCOUNT_TYPE_OFFSET = 165;
const MINT_TLV_START = 166;

export type DbcPoolState = {
  readonly address: string;
  readonly pool: VirtualPool;
  readonly config: PoolConfig;
  readonly baseTokenProgram: TokenProgram;
};

export type DbcBuyResult =
  | {
      readonly kind: 'ok';
      readonly state: DbcPoolState;
      readonly quote: BuyQuote;
      readonly minimumAmountOut: bigint;
      /** Slot or unix time the fee schedule was read at (config `activation_type`). */
      readonly currentPoint: bigint;
    }
  /** No DBC pool for this mint. */
  | { readonly kind: 'no-pool' }
  /** The curve is complete or the pool has migrated: "after graduation", no transaction. */
  | { readonly kind: 'graduated'; readonly state: DbcPoolState }
  /** Quoted in a token other than SOL (provisional decision 2026-10-12 in BUNNDLY-47). */
  | { readonly kind: 'unsupported-quote'; readonly quoteMint: string }
  /** A Token-2022 base mint with an extension listed above. */
  | { readonly kind: 'unsupported-token'; readonly extension: string }
  /** The amount is larger than what is left on the curve. */
  | {
      readonly kind: 'insufficient-liquidity';
      readonly state: DbcPoolState;
      readonly amountLeft: bigint;
    }
  /** Trading has not started yet (current point before `activation_point`). */
  | { readonly kind: 'not-active'; readonly state: DbcPoolState; readonly activationPoint: bigint };

const encodeAddress = (bytes: Uint8Array): string => getAddressDecoder().decode(bytes);

function accountBytes(data: unknown): Uint8Array {
  if (!Array.isArray(data) || typeof data[0] !== 'string' || data[1] !== 'base64') {
    throw new Error('expected base64 account data');
  }
  return base64.decode(data[0]);
}

/** Token program of a base mint, or the first unsupported Token-2022 extension. */
export function checkBaseMint(
  owner: string,
  data: Uint8Array,
): { readonly program: TokenProgram } | { readonly unsupported: string } {
  if (owner === TOKEN_PROGRAM_ADDRESS) return { program: 'spl-token' };
  if (owner !== TOKEN_2022_PROGRAM_ADDRESS) return { unsupported: 'not-a-token-mint' };
  if (data.length <= MINT_ACCOUNT_TYPE_OFFSET) return { program: 'token-2022' };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = MINT_TLV_START;
  while (at + 4 <= data.length) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (type === 0) break; // Uninitialized: the rest is padding
    const name = UNSUPPORTED_EXTENSIONS[type];
    if (name !== undefined) return { unsupported: name };
    at += 4 + length;
  }
  return { program: 'token-2022' };
}

/** Reads the DBC pool of `mint`, its config and the base mint; null when there is none. */
export async function fetchDbcPool(
  rpc: DbcRpc,
  mint: string,
): Promise<DbcPoolState | { readonly unsupported: string } | null> {
  const found = await rpc
    .getProgramAccounts(address(DBC_PROGRAM_ADDRESS), {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { dataSize: BigInt(VIRTUAL_POOL_SIZE) },
        {
          memcmp: {
            offset: BigInt(POOL_BASE_MINT_OFFSET),
            bytes: mint as Base58EncodedBytes,
            encoding: 'base58',
          },
        },
      ],
    })
    .send();
  for (const { pubkey, account } of found) {
    const pool = decodeVirtualPool(accountBytes(account.data), encodeAddress);
    if (pool.baseMint !== mint) continue;
    const configInfo = await rpc
      .getAccountInfo(address(pool.config), { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!configInfo.value || configInfo.value.owner !== DBC_PROGRAM_ADDRESS) continue;
    const config = decodePoolConfig(accountBytes(configInfo.value.data), encodeAddress);
    // The account must be the pool PDA for (config, base, quote), not a lookalike.
    const pda = await findDbcPoolAddress(pool.config, pool.baseMint, config.quoteMint);
    if (pda !== pubkey) continue;
    const mintInfo = await rpc
      .getAccountInfo(address(mint), { encoding: 'base64', commitment: 'confirmed' })
      .send();
    if (!mintInfo.value) continue;
    const base = checkBaseMint(mintInfo.value.owner, accountBytes(mintInfo.value.data));
    if ('unsupported' in base) return base;
    return { address: pubkey, pool, config, baseTokenProgram: base.program };
  }
  return null;
}

/** Slot or unix time, whichever the config's `activation_type` counts in. */
export async function fetchCurrentPoint(rpc: DbcRpc, activationType: number): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  if (activationType === ActivationType.Slot) return slot;
  return BigInt(await rpc.getBlockTime(slot).send());
}

/** Pure part of the quote: every explicit "no" before the curve math. */
export function quoteFromState(
  state: DbcPoolState,
  lamportsIn: bigint,
  slippageBps: number,
  currentPoint: bigint,
): DbcBuyResult {
  const { pool, config } = state;
  if (config.quoteMint !== WSOL_MINT) {
    return { kind: 'unsupported-quote', quoteMint: config.quoteMint };
  }
  if (pool.isMigrated) return { kind: 'graduated', state };
  if (currentPoint < pool.activationPoint) {
    return { kind: 'not-active', state, activationPoint: pool.activationPoint };
  }
  const result = quoteBuyExactIn(pool, config, lamportsIn, currentPoint);
  if (result.kind === 'completed') return { kind: 'graduated', state };
  if (result.kind === 'insufficient-liquidity') {
    return { kind: 'insufficient-liquidity', state, amountLeft: result.amountLeft };
  }
  return {
    kind: 'ok',
    state,
    quote: result.quote,
    minimumAmountOut: minimumAmountOut(result.quote.outputAmount, slippageBps),
    currentPoint,
  };
}

/** Finds the pool of `mint` and quotes a buy for `lamportsIn`. */
export async function quoteDbcBuy(
  rpc: DbcRpc,
  mint: string,
  lamportsIn: bigint,
  slippageBps: number,
): Promise<DbcBuyResult> {
  const state = await fetchDbcPool(rpc, mint);
  if (state === null) return { kind: 'no-pool' };
  if ('unsupported' in state) return { kind: 'unsupported-token', extension: state.unsupported };
  const point = await fetchCurrentPoint(rpc, state.config.activationType);
  return quoteFromState(state, lamportsIn, slippageBps, point);
}
