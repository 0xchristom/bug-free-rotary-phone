/**
 * DBC buys from mainnet and devnet (BUNNDLY-47): the quote for the transaction's input must
 * equal the tokens the buyer really got, read from the token balances before and after in
 * the transaction meta (tests/fixtures/meteora-dbc.{mainnet,devnet}.json, raw chain data).
 * The built swap instruction must match the real one byte for byte. The devnet buys use
 * swap mode 1 (PartialFill), which fills like ExactIn when the amount fits on the curve;
 * there only the mode byte differs from what the module builds.
 */
import { getAddressDecoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  ActivationType,
  DBC_PROGRAM_ADDRESS,
  SWAP2_DISCRIMINATOR,
  WSOL_MINT,
  buildBuyInstructions,
  checkBaseMint,
  decodePoolConfig,
  decodeVirtualPool,
  findDbcEventAuthority,
  findDbcPoolAddress,
  findDbcPoolAuthority,
  quoteFromState,
  type DbcPoolState,
} from '../../src/direct/meteora-dbc/index.ts';
import { findAssociatedTokenAddress } from '../../src/chain/tokens.ts';
import devnet from '../fixtures/meteora-dbc.devnet.json';
import mainnet from '../fixtures/meteora-dbc.mainnet.json';

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
/** One captured buy, the shape written to tests/fixtures/meteora-dbc.*.json. */
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
  readonly instructions: readonly Ix[];
  readonly swap: Ix;
  readonly fee: number;
  readonly payerLamportsPre: number;
  readonly payerLamportsPost: number;
  readonly createdAccounts: readonly { account: string; pre: number; post: number }[];
  readonly payerTokenBalancesPre: readonly TokenBalance[];
  readonly payerTokenBalancesPost: readonly TokenBalance[];
}

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
const encode = (b: Uint8Array) => getAddressDecoder().decode(b);
const u64 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const SYSTEM = '11111111111111111111111111111111';

function received(c: Case): bigint {
  const amount = (list: readonly TokenBalance[]) =>
    BigInt(list.find((b) => b.mint === c.baseMint)?.amount ?? '0');
  return amount(c.payerTokenBalancesPost) - amount(c.payerTokenBalancesPre);
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
/** IDL `SwapMode`: 0 ExactIn, 1 PartialFill. */
const EXACT_IN = 0;
const PARTIAL_FILL = 1;

describe('fixtures', () => {
  it('hold at least 3 mainnet and 2 devnet buys of SOL-quoted pools, each a swap2', () => {
    expect(mainnetCases.length).toBeGreaterThanOrEqual(3);
    expect(devnetCases.length).toBeGreaterThanOrEqual(2);
    for (const c of cases) {
      const data = bytes(c.swap.data);
      expect([...data.subarray(0, 8)]).toEqual([...SWAP2_DISCRIMINATOR]);
      expect([EXACT_IN, PARTIAL_FILL]).toContain(data[24]);
      expect(c.swap.accounts[8]).toBe(WSOL_MINT);
      expect(received(c)).toBeGreaterThan(0n);
    }
  });
});

describe.each(cases)('$network buy $signature', (c) => {
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

  it('quotes exactly the tokens the buyer received (meta balances)', () => {
    const r = quoteFromState(state, amountIn, 0, point);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.quote.outputAmount).toBe(received(c));
    // the transaction's own floor held: our quote is at or above it
    expect(r.quote.outputAmount).toBeGreaterThanOrEqual(minOut);
  });

  it('builds the same swap2 instruction: accounts in order and data byte for byte', async () => {
    // the module always sends ExactIn; a PartialFill fixture differs only in that byte
    const built = await buildBuyInstructions({
      payer: c.payer,
      pool: c.pool,
      config: c.config,
      baseMint: c.baseMint,
      baseVault: state.pool.baseVault,
      quoteVault: state.pool.quoteVault,
      baseTokenProgram: state.baseTokenProgram,
      lamportsIn: amountIn,
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

  it('spends on chain exactly input + fee + new account rent + other transfers', () => {
    // independent of the module: lamports out of the payer from the meta, explained only
    // by the swap input, the network fee, the rent of accounts the transaction created
    // and other System transfers from the payer (e.g. a tip); the wrapped SOL account
    // returns its rent on close.
    const top = c.instructions;
    const transfersOut = top
      .filter((ix) => ix.program === SYSTEM && ix.accounts[0] === c.payer)
      .map((ix) => bytes(ix.data))
      .filter((d) => d[0] === 2)
      .map((d) => u64(d, 4));
    const wrapTransfer = transfersOut.reduce((s, x) => s + x, 0n);
    const rent = c.createdAccounts.reduce((s, a) => s + BigInt(a.post), 0n);
    const spent = BigInt(c.payerLamportsPre) - BigInt(c.payerLamportsPost);
    expect(spent).toBe(wrapTransfer + BigInt(c.fee) + rent);
    expect(transfersOut).toContain(amountIn);
  });
});

describe('built buy spends no more than input + fees + token account rent', () => {
  const c = cases[0];
  if (!c) throw new Error('no fixture');
  const state = stateOf(c);

  it('moves SOL only once, for exactly the input, and closes the wrapped SOL account', async () => {
    const lamportsIn = 123_456_789n;
    const ixs = await buildBuyInstructions({
      payer: c.payer,
      pool: c.pool,
      config: c.config,
      baseMint: c.baseMint,
      baseVault: state.pool.baseVault,
      quoteVault: state.pool.quoteVault,
      baseTokenProgram: state.baseTokenProgram,
      lamportsIn,
      minimumAmountOut: 1n,
      computeUnitLimit: 150_000,
      computeUnitPriceMicroLamports: 10_000n,
    });
    const wsolAta = await findAssociatedTokenAddress(c.payer, WSOL_MINT, 'spl-token');
    const baseAta = await findAssociatedTokenAddress(c.payer, c.baseMint, state.baseTokenProgram);
    const programs = ixs.map((ix) => ix.programAddress);
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      SYSTEM,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      DBC_PROGRAM_ADDRESS,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ]);
    // the only lamport move: payer → wrapped SOL account, exactly the input (tag 2, u64)
    const transfer = ixs[4];
    expect(transfer?.accounts?.map((a) => a.address)).toEqual([c.payer, wsolAta]);
    expect([...(transfer?.data ?? [])]).toEqual([2, 0, 0, 0, 0x15, 0xcd, 0x5b, 0x07, 0, 0, 0, 0]);
    // the swap spends exactly the input (amount_0) from that account
    const swap = ixs[6];
    expect(swap?.accounts?.[3]?.address).toBe(wsolAta);
    expect(u64(Uint8Array.from(swap?.data ?? []), 8)).toBe(lamportsIn);
    // the two created accounts are the payer's ATAs (rent is the only other cost) and
    // the wrapped SOL one is closed back to the payer
    expect(ixs[2]?.accounts?.[1]?.address).toBe(wsolAta);
    expect(ixs[3]?.accounts?.[1]?.address).toBe(baseAta);
    expect(ixs[7]?.accounts?.map((a) => a.address)).toEqual([wsolAta, c.payer, c.payer]);
    expect([...(ixs[7]?.data ?? [])]).toEqual([9]);
    // compute: limit 150 000 (u32), price 10 000 µlamports (u64) → priority fee 1 500 lamports
    expect([...(ixs[0]?.data ?? [])]).toEqual([2, 0xf0, 0x49, 0x02, 0x00]);
    expect([...(ixs[1]?.data ?? [])]).toEqual([3, 0x10, 0x27, 0, 0, 0, 0, 0, 0]);
  });

  it('derives the authorities the real swap used', async () => {
    expect(await findDbcPoolAuthority()).toBe(c.swap.accounts[0]);
    expect(await findDbcEventAuthority()).toBe(c.swap.accounts[13]);
  });
});
