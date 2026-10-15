/**
 * Instructions of a Meteora DBC buy (BUNNDLY-47, D-053), built on `@solana/kit` without
 * the SDK. Order is the one real buys on mainnet use (fixtures in tests/fixtures):
 *
 *   1. ComputeBudget SetComputeUnitLimit and SetComputeUnitPrice
 *   2. ATA CreateIdempotent for wrapped SOL (SPL Token) and for the base token
 *   3. System Transfer of the input lamports into the wrapped SOL account, Token SyncNative
 *   4. DBC `swap2` (exact in: amount_0 = lamports in, amount_1 = minimum out, mode 0)
 *   5. Token CloseAccount of the wrapped SOL account back to the payer (rent returns)
 *
 * `swap2` accounts and discriminator: IDL `dynamic_bonding_curve` 0.2.1 (SDK 1.5.13, MIT).
 * Optional `referral_token_account` is unused; Anchor takes the program address for
 * "none". Other programs: official docs, links next to each constant.
 */
import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenAddress,
  programAddress,
  type TokenProgram,
} from '../../chain/tokens.ts';
import { DBC_PROGRAM_ADDRESS } from './accounts.ts';

/** https://solana.com/docs/core/fees#compute-budget (program id). */
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = 'ComputeBudget111111111111111111111111111111';
/** Wrapped SOL mint, https://spl.solana.com/token#wrapping-sol */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** IDL `swap2.discriminator`. */
export const SWAP2_DISCRIMINATOR = [65, 75, 63, 76, 235, 91, 91, 136] as const;
/** IDL `SwapMode`: 0 = ExactIn. */
const SWAP_MODE_EXACT_IN = 0;

/** PDA seeds from the IDL (`pool_authority`, `__event_authority`). */
export async function findDbcPoolAuthority(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(DBC_PROGRAM_ADDRESS),
    seeds: ['pool_authority'],
  });
  return pda;
}

export async function findDbcEventAuthority(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(DBC_PROGRAM_ADDRESS),
    seeds: ['__event_authority'],
  });
  return pda;
}

/**
 * Pool PDA (SDK `deriveDbcPoolAddress`): seeds "pool", config, then the larger of the two
 * mints by bytes, then the smaller.
 */
export async function findDbcPoolAddress(
  config: string,
  baseMint: string,
  quoteMint: string,
): Promise<Address> {
  const enc = getAddressEncoder();
  const base = enc.encode(address(baseMint));
  const quote = enc.encode(address(quoteMint));
  const quoteBigger = compareBytes(quote, base) > 0;
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(DBC_PROGRAM_ADDRESS),
    seeds: ['pool', enc.encode(address(config)), ...(quoteBigger ? [quote, base] : [base, quote])],
  });
  return pda;
}

function compareBytes(a: ArrayLike<number>, b: ArrayLike<number>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 64n) throw new RangeError('u64 out of range');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ro = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
const w = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE });
const ws = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE_SIGNER });

/** ComputeBudgetInstruction::SetComputeUnitLimit = 2 (u32). */
export function setComputeUnitLimit(units: number): Instruction {
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS),
    accounts: [],
    data: concat([2], u32le(units)),
  };
}

/** ComputeBudgetInstruction::SetComputeUnitPrice = 3 (u64 micro-lamports). */
export function setComputeUnitPrice(microLamports: bigint): Instruction {
  return {
    programAddress: address(COMPUTE_BUDGET_PROGRAM_ADDRESS),
    accounts: [],
    data: concat([3], u64le(microLamports)),
  };
}

/**
 * ATA program `CreateIdempotent` = 1:
 * https://spl.solana.com/associated-token-account (funding, ata, wallet, mint, system, token program).
 */
export function createAtaIdempotent(
  payer: string,
  ata: string,
  mint: string,
  tokenProgram: string,
): Instruction {
  return {
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
    accounts: [
      ws(payer),
      w(ata),
      ro(payer),
      ro(mint),
      ro(SYSTEM_PROGRAM_ADDRESS),
      ro(tokenProgram),
    ],
    data: new Uint8Array([1]),
  };
}

/** System Program `Transfer` = 2 (u32 tag, u64 lamports). */
export function transferSol(from: string, to: string, lamports: bigint): Instruction {
  return {
    programAddress: address(SYSTEM_PROGRAM_ADDRESS),
    accounts: [ws(from), w(to)],
    data: concat(u32le(2), u64le(lamports)),
  };
}

/** SPL Token `SyncNative` = 17. */
export function syncNative(account: string): Instruction {
  return {
    programAddress: address(TOKEN_PROGRAM_ADDRESS),
    accounts: [w(account)],
    data: new Uint8Array([17]),
  };
}

/** SPL Token `CloseAccount` = 9 (account, destination, owner). */
export function closeAccount(account: string, destination: string, owner: string): Instruction {
  return {
    programAddress: address(TOKEN_PROGRAM_ADDRESS),
    accounts: [
      w(account),
      w(destination),
      { address: address(owner), role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([9]),
  };
}

export interface Swap2Accounts {
  readonly poolAuthority: string;
  readonly config: string;
  readonly pool: string;
  readonly inputTokenAccount: string;
  readonly outputTokenAccount: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly payer: string;
  readonly tokenBaseProgram: string;
  readonly tokenQuoteProgram: string;
  readonly eventAuthority: string;
}

/** DBC `swap2` exact in, accounts in IDL order. */
export function swap2ExactIn(
  a: Swap2Accounts,
  amountIn: bigint,
  minimumAmountOut: bigint,
): Instruction {
  return {
    programAddress: address(DBC_PROGRAM_ADDRESS),
    accounts: [
      ro(a.poolAuthority),
      ro(a.config),
      w(a.pool),
      w(a.inputTokenAccount),
      w(a.outputTokenAccount),
      w(a.baseVault),
      w(a.quoteVault),
      ro(a.baseMint),
      ro(a.quoteMint),
      { address: address(a.payer), role: AccountRole.READONLY_SIGNER },
      ro(a.tokenBaseProgram),
      ro(a.tokenQuoteProgram),
      ro(DBC_PROGRAM_ADDRESS), // referral_token_account: none
      ro(a.eventAuthority),
      ro(DBC_PROGRAM_ADDRESS),
    ],
    data: concat(SWAP2_DISCRIMINATOR, u64le(amountIn), u64le(minimumAmountOut), [
      SWAP_MODE_EXACT_IN,
    ]),
  };
}

export interface BuyParams {
  readonly payer: string;
  readonly pool: string;
  readonly config: string;
  readonly baseMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly baseTokenProgram: TokenProgram;
  readonly lamportsIn: bigint;
  readonly minimumAmountOut: bigint;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
}

/** The whole buy, in the order described at the top of the file. */
export async function buildBuyInstructions(p: BuyParams): Promise<Instruction[]> {
  if (p.lamportsIn <= 0n) throw new RangeError('lamportsIn must be positive');
  const baseProgram = programAddress(p.baseTokenProgram);
  const [wsolAta, baseAta, poolAuthority, eventAuthority] = await Promise.all([
    findAssociatedTokenAddress(p.payer, WSOL_MINT, 'spl-token'),
    findAssociatedTokenAddress(p.payer, p.baseMint, p.baseTokenProgram),
    findDbcPoolAuthority(),
    findDbcEventAuthority(),
  ]);
  return [
    setComputeUnitLimit(p.computeUnitLimit),
    setComputeUnitPrice(p.computeUnitPriceMicroLamports),
    createAtaIdempotent(p.payer, wsolAta, WSOL_MINT, TOKEN_PROGRAM_ADDRESS),
    createAtaIdempotent(p.payer, baseAta, p.baseMint, baseProgram),
    transferSol(p.payer, wsolAta, p.lamportsIn),
    syncNative(wsolAta),
    swap2ExactIn(
      {
        poolAuthority,
        config: p.config,
        pool: p.pool,
        inputTokenAccount: wsolAta,
        outputTokenAccount: baseAta,
        baseVault: p.baseVault,
        quoteVault: p.quoteVault,
        baseMint: p.baseMint,
        quoteMint: WSOL_MINT,
        payer: p.payer,
        tokenBaseProgram: baseProgram,
        tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
        eventAuthority,
      },
      p.lamportsIn,
      p.minimumAmountOut,
    ),
    closeAccount(wsolAta, p.payer, p.payer),
  ];
}

export interface SellParams {
  readonly payer: string;
  readonly pool: string;
  readonly config: string;
  readonly baseMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly baseTokenProgram: TokenProgram;
  /** Base token units sold. */
  readonly amountIn: bigint;
  /** Lamports out, after fees (`minimumAmountOut` of the quote). */
  readonly minimumAmountOut: bigint;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
}

/**
 * The whole sell (BUNNDLY-63), the order real sells on mainnet use (fixtures in tests/fixtures):
 * compute budget, ATA CreateIdempotent for wrapped SOL, `swap2` base → SOL (input = the base
 * ATA, output = the wrapped SOL ATA), CloseAccount of the wrapped SOL account to the payer,
 * which turns the output and the rent back into lamports.
 */
export async function buildSellInstructions(p: SellParams): Promise<Instruction[]> {
  if (p.amountIn <= 0n) throw new RangeError('amountIn must be positive');
  const baseProgram = programAddress(p.baseTokenProgram);
  const [wsolAta, baseAta, poolAuthority, eventAuthority] = await Promise.all([
    findAssociatedTokenAddress(p.payer, WSOL_MINT, 'spl-token'),
    findAssociatedTokenAddress(p.payer, p.baseMint, p.baseTokenProgram),
    findDbcPoolAuthority(),
    findDbcEventAuthority(),
  ]);
  return [
    setComputeUnitLimit(p.computeUnitLimit),
    setComputeUnitPrice(p.computeUnitPriceMicroLamports),
    createAtaIdempotent(p.payer, wsolAta, WSOL_MINT, TOKEN_PROGRAM_ADDRESS),
    swap2ExactIn(
      {
        poolAuthority,
        config: p.config,
        pool: p.pool,
        inputTokenAccount: baseAta,
        outputTokenAccount: wsolAta,
        baseVault: p.baseVault,
        quoteVault: p.quoteVault,
        baseMint: p.baseMint,
        quoteMint: WSOL_MINT,
        payer: p.payer,
        tokenBaseProgram: baseProgram,
        tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
        eventAuthority,
      },
      p.amountIn,
      p.minimumAmountOut,
    ),
    closeAccount(wsolAta, p.payer, p.payer),
  ];
}
