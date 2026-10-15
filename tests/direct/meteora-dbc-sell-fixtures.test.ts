/**
 * DBC sells (base → SOL) from mainnet and devnet (BUNNDLY-63). The quote for the tokens
 * sold must equal, to the lamport, the SOL the seller really got, worked out from the
 * transaction meta alone (tests/fixtures/meteora-dbc-sell.{mainnet,devnet}.json, raw chain
 * data): the payer's lamport change plus the network fee it paid, plus what it sent to
 * others and the rent of accounts it left open, minus what the closed wrapped SOL account
 * held before the transaction. The built swap2 must match the real one byte for byte in
 * accounts, order, discriminator and mode.
 */
import { getAddressDecoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  ActivationType,
  DBC_PROGRAM_ADDRESS,
  SWAP2_DISCRIMINATOR,
  WSOL_MINT,
  buildSellInstructions,
  checkBaseMint,
  decodePoolConfig,
  decodeVirtualPool,
  findDbcPoolAddress,
  sellQuoteFromState,
  type DbcPoolState,
} from '../../src/direct/meteora-dbc/index.ts';
import { findAssociatedTokenAddress } from '../../src/chain/tokens.ts';
import devnet from '../fixtures/meteora-dbc-sell.devnet.json';
import mainnet from '../fixtures/meteora-dbc-sell.mainnet.json';

interface Ix {
  readonly program: string;
  readonly accounts: readonly string[];
  readonly data: string;
}
interface TokenBalance {
  readonly account: string;
  readonly mint: string;
  readonly amount: string;
}
/** One captured sell, the shape written to tests/fixtures/meteora-dbc-sell.*.json. */
interface Case {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly pool: string;
  readonly poolData: string;
  readonly config: string;
  readonly configData: string;
  readonly baseMint: string;
  readonly baseMintOwner: string;
  readonly baseMintData: string;
  readonly payer: string;
  readonly feePayer: string;
  readonly instructions: readonly Ix[];
  readonly swap: Ix;
  readonly fee: number;
  readonly payerLamportsPre: number;
  readonly payerLamportsPost: number;
  readonly createdAccounts: readonly { account: string; pre: number; post: number }[];
  readonly payerTokenBalancesPre: readonly TokenBalance[];
  readonly payerTokenBalancesPost: readonly TokenBalance[];
  readonly outputAccount: string;
  readonly outputAccountLamportsPre: number;
  readonly outputAccountLamportsPost: number;
}

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
const encode = (b: Uint8Array) => getAddressDecoder().decode(b);
const u64 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
/** IDL `SwapMode`: 0 ExactIn, 1 PartialFill. */
const EXACT_IN = 0;
const PARTIAL_FILL = 1;

/** Base tokens that left the payer, from the meta token balances. */
function sold(c: Case): bigint {
  const amount = (list: readonly TokenBalance[]) =>
    BigInt(list.find((b) => b.mint === c.baseMint)?.amount ?? '0');
  return amount(c.payerTokenBalancesPre) - amount(c.payerTokenBalancesPost);
}

/** Lamports the sell brought the payer, from the meta only (see the top of the file). */
function solReceived(c: Case): bigint {
  const delta = BigInt(c.payerLamportsPost) - BigInt(c.payerLamportsPre);
  const fee = c.feePayer === c.payer ? BigInt(c.fee) : 0n;
  const transfersOut = c.instructions
    .filter((ix) => ix.program === SYSTEM && ix.accounts[0] === c.payer)
    .map((ix) => bytes(ix.data))
    .filter((d) => d[0] === 2)
    .reduce((s, d) => s + u64(d, 4), 0n);
  const rentLeftOpen = c.createdAccounts.reduce((s, a) => s + BigInt(a.post), 0n);
  return delta + fee + transfersOut + rentLeftOpen - BigInt(c.outputAccountLamportsPre);
}

function stateOf(c: Case): DbcPoolState {
  const base = checkBaseMint(c.baseMintOwner, bytes(c.baseMintData));
  if ('unsupported' in base) throw new Error(base.unsupported);
  return {
    address: c.pool,
    pool: decodeVirtualPool(bytes(c.poolData), encode),
    config: decodePoolConfig(bytes(c.configData), encode),
    baseTokenProgram: base.program,
  };
}

const mainnetCases: readonly Case[] = mainnet.cases;
const devnetCases: readonly Case[] = devnet.cases;
const cases = [
  ...mainnetCases.map((c) => ({ ...c, network: 'mainnet' })),
  ...devnetCases.map((c) => ({ ...c, network: 'devnet' })),
];

describe('sell fixtures', () => {
  it('hold at least 3 mainnet sells of SOL-quoted pools, each a swap2 base → wrapped SOL', () => {
    expect(mainnetCases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      const data = bytes(c.swap.data);
      expect([...data.subarray(0, 8)]).toEqual([...SWAP2_DISCRIMINATOR]);
      expect([EXACT_IN, PARTIAL_FILL]).toContain(data[24]);
      expect(c.swap.accounts[8]).toBe(WSOL_MINT);
      expect(c.swap.accounts[4]).toBe(c.outputAccount);
      // the wrapped SOL account is closed in the same transaction
      expect(c.outputAccountLamportsPost).toBe(0);
      expect(sold(c)).toBeGreaterThan(0n);
    }
  });

  it('cover both collect fee modes: fee in SOL (0, devnet) and in the output (1, mainnet)', () => {
    const modes = (list: readonly Case[]) =>
      [...new Set(list.map((c) => stateOf(c).config.collectFeeMode))].sort();
    expect(modes(mainnetCases)).toEqual([1]);
    expect(modes(devnetCases)).toEqual([0]);
  });
});

describe.each(cases)('$network sell $signature', (c) => {
  const state = stateOf(c);
  const data = bytes(c.swap.data);
  const amountIn = u64(data, 8);
  const minOut = u64(data, 16);
  const point =
    state.config.activationType === ActivationType.Slot ? BigInt(c.slot) : BigInt(c.blockTime);

  it('decodes the pool that the transaction swapped on', async () => {
    expect(state.pool.baseMint).toBe(c.baseMint);
    expect(state.pool.config).toBe(c.config);
    expect(state.pool.baseVault).toBe(c.swap.accounts[5]);
    expect(state.pool.quoteVault).toBe(c.swap.accounts[6]);
    expect(state.config.quoteMint).toBe(WSOL_MINT);
    expect(await findDbcPoolAddress(c.config, c.baseMint, WSOL_MINT)).toBe(c.pool);
  });

  it('sold exactly amount_0 tokens (meta balances)', () => {
    expect(sold(c)).toBe(amountIn);
  });

  it('quotes exactly the SOL the seller received (payer lamports from the meta)', () => {
    const r = sellQuoteFromState(state, amountIn, 0, point);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.quote.outputAmount).toBe(solReceived(c));
    expect(r.quote.outputAmount).toBeGreaterThanOrEqual(minOut);
  });

  it('builds the same swap2 instruction: accounts in order and data byte for byte', async () => {
    const built = await buildSellInstructions({
      payer: c.payer,
      pool: c.pool,
      config: c.config,
      baseMint: c.baseMint,
      baseVault: state.pool.baseVault,
      quoteVault: state.pool.quoteVault,
      baseTokenProgram: state.baseTokenProgram,
      amountIn,
      minimumAmountOut: minOut,
      computeUnitLimit: 200_000,
      computeUnitPriceMicroLamports: 0n,
    });
    const swap = built.find((ix) => ix.programAddress === DBC_PROGRAM_ADDRESS);
    expect(swap?.accounts?.map((a) => a.address)).toEqual(c.swap.accounts);
    const builtData = [...(swap?.data ?? [])];
    expect(builtData.slice(0, 24)).toEqual([...data.subarray(0, 24)]);
    expect(builtData.length).toBe(data.length);
    expect(builtData[24]).toBe(EXACT_IN);
    if (data[24] === EXACT_IN) expect(builtData).toEqual([...data]);
  });
});

describe('built sell', () => {
  const c = cases[0];
  if (!c) throw new Error('no fixture');
  const state = stateOf(c);

  it('creates and closes only the wrapped SOL account and moves no lamports itself', async () => {
    const ixs = await buildSellInstructions({
      payer: c.payer,
      pool: c.pool,
      config: c.config,
      baseMint: c.baseMint,
      baseVault: state.pool.baseVault,
      quoteVault: state.pool.quoteVault,
      baseTokenProgram: state.baseTokenProgram,
      amountIn: 123_456_789n,
      minimumAmountOut: 7n,
      computeUnitLimit: 150_000,
      computeUnitPriceMicroLamports: 10_000n,
    });
    const wsolAta = await findAssociatedTokenAddress(c.payer, WSOL_MINT, 'spl-token');
    const baseAta = await findAssociatedTokenAddress(c.payer, c.baseMint, state.baseTokenProgram);
    expect(ixs.map((ix) => ix.programAddress)).toEqual([
      COMPUTE,
      COMPUTE,
      ATA,
      DBC_PROGRAM_ADDRESS,
      TOKEN,
    ]);
    expect(ixs[2]?.accounts?.map((a) => a.address)).toEqual([
      c.payer,
      wsolAta,
      c.payer,
      WSOL_MINT,
      SYSTEM,
      TOKEN,
    ]);
    expect([...(ixs[2]?.data ?? [])]).toEqual([1]);
    // input = the base ATA, output = the wrapped SOL ATA; amounts and mode 0 in the data
    const swap = ixs[3];
    expect(swap?.accounts?.[3]?.address).toBe(baseAta);
    expect(swap?.accounts?.[4]?.address).toBe(wsolAta);
    const d = Uint8Array.from(swap?.data ?? []);
    expect(u64(d, 8)).toBe(123_456_789n);
    expect(u64(d, 16)).toBe(7n);
    expect(d[24]).toBe(EXACT_IN);
    expect(ixs[4]?.accounts?.map((a) => a.address)).toEqual([wsolAta, c.payer, c.payer]);
    expect([...(ixs[4]?.data ?? [])]).toEqual([9]);
  });

  it('refuses zero tokens', async () => {
    await expect(
      buildSellInstructions({
        payer: c.payer,
        pool: c.pool,
        config: c.config,
        baseMint: c.baseMint,
        baseVault: state.pool.baseVault,
        quoteVault: state.pool.quoteVault,
        baseTokenProgram: state.baseTokenProgram,
        amountIn: 0n,
        minimumAmountOut: 0n,
        computeUnitLimit: 150_000,
        computeUnitPriceMicroLamports: 0n,
      }),
    ).rejects.toThrow(RangeError);
  });
});
