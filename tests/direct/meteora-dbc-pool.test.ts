/**
 * Finding a DBC pool for a mint and the explicit "no quote" results (BUNNDLY-47). The RPC
 * is a fake that serves raw accounts from tests/fixtures/meteora-dbc.mainnet.json.
 */
import { getAddressDecoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  checkBaseMint,
  decodePoolConfig,
  decodeVirtualPool,
  fetchDbcPool,
  quoteDbcBuy,
  quoteFromState,
  type DbcPoolState,
  type DbcRpc,
} from '../../src/direct/meteora-dbc/index.ts';
import mainnet from '../fixtures/meteora-dbc.mainnet.json';

const first = mainnet.cases[0];
if (!first) throw new Error('no fixture');
const c = first;
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, 'base64'));
const encode = (b: Uint8Array) => getAddressDecoder().decode(b);
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

interface FakeAccount {
  readonly owner: string;
  readonly data: string;
}

function fakeRpc(
  programAccounts: readonly { pubkey: string; account: FakeAccount }[],
  accounts: Readonly<Record<string, FakeAccount>>,
  point = { slot: BigInt(c.slot), time: BigInt(c.blockTime) },
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const send = <T>(value: T) => ({ send: () => Promise.resolve(value) });
  const wrap = (a: FakeAccount) => ({ ...a, data: [a.data, 'base64'] as const });
  const rpc = {
    getProgramAccounts: (...args: unknown[]) => {
      calls.push({ method: 'getProgramAccounts', args });
      return send(programAccounts.map((p) => ({ pubkey: p.pubkey, account: wrap(p.account) })));
    },
    getAccountInfo: (key: string) => {
      calls.push({ method: 'getAccountInfo', args: [key] });
      const a = accounts[key];
      return send({ value: a ? wrap(a) : null });
    },
    getSlot: () => send(point.slot),
    getBlockTime: () => send(point.time),
  };
  return { rpc: rpc as unknown as DbcRpc, calls };
}

const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const poolAccount = { owner: DBC, data: c.poolData };
const known = {
  [c.config]: { owner: DBC, data: c.configData },
  [c.baseMint]: { owner: c.baseMintOwner, data: c.baseMintData },
};

describe('fetchDbcPool', () => {
  it('asks for pool-sized accounts with the mint at the base_mint offset', async () => {
    const { rpc, calls } = fakeRpc([{ pubkey: c.pool, account: poolAccount }], known);
    const state = await fetchDbcPool(rpc, c.baseMint);
    expect(state).toMatchObject({ address: c.pool, baseTokenProgram: 'token-2022' });
    const [, options] = calls[0]?.args as [unknown, { filters: unknown[] }];
    // 8 discriminator + 416 VirtualPool; base_mint at 8 + 128
    expect(options.filters).toEqual([
      { dataSize: 424n },
      { memcmp: { offset: 136n, bytes: c.baseMint, encoding: 'base58' } },
    ]);
  });

  it('skips an account that has the pool layout but is not the pool PDA', async () => {
    const lookalike = '11111111111111111111111111111112';
    const { rpc } = fakeRpc([{ pubkey: lookalike, account: poolAccount }], known);
    expect(await fetchDbcPool(rpc, c.baseMint)).toBeNull();
  });

  it('no pool for the mint: null, and quoteDbcBuy says no-pool', async () => {
    const { rpc } = fakeRpc([], known);
    expect(await fetchDbcPool(rpc, c.baseMint)).toBeNull();
    expect(await quoteDbcBuy(rpc, c.baseMint, 1_000_000n, 100)).toEqual({ kind: 'no-pool' });
  });
});

describe('quoteDbcBuy', () => {
  it('quotes with the point the config counts in and applies the slippage floor', async () => {
    const { rpc } = fakeRpc([{ pubkey: c.pool, account: poolAccount }], known);
    const r = await quoteDbcBuy(rpc, c.baseMint, 10_000_000n, 100);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const config = decodePoolConfig(bytes(c.configData), encode);
    expect(r.currentPoint).toBe(config.activationType === 0 ? BigInt(c.slot) : BigInt(c.blockTime));
    expect(r.minimumAmountOut).toBe((r.quote.outputAmount * 9900n) / 10_000n);
  });
});

describe('explicit results', () => {
  const state: DbcPoolState = {
    address: c.pool,
    pool: decodeVirtualPool(bytes(c.poolData), encode),
    config: decodePoolConfig(bytes(c.configData), encode),
    baseTokenProgram: 'token-2022',
  };
  const now = BigInt(c.blockTime);

  it('a pool quoted in another token is unsupported', () => {
    const usdc = {
      ...state,
      config: { ...state.config, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    };
    expect(quoteFromState(usdc, 1n, 0, now)).toEqual({
      kind: 'unsupported-quote',
      quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
  });

  it('a migrated pool and a full curve are "graduated", with no quote', () => {
    const migrated = { ...state, pool: { ...state.pool, isMigrated: true } };
    expect(quoteFromState(migrated, 1n, 0, now).kind).toBe('graduated');
    const full = {
      ...state,
      pool: { ...state.pool, quoteReserve: state.config.migrationQuoteThreshold },
    };
    expect(quoteFromState(full, 1n, 0, now).kind).toBe('graduated');
  });

  it('more SOL than the rest of the curve takes: insufficient liquidity, not a quote', () => {
    // the rest of the curve costs about threshold − reserve; ten times the threshold cannot fit
    const r = quoteFromState(state, state.config.migrationQuoteThreshold * 10n, 0, now);
    expect(r.kind).toBe('insufficient-liquidity');
  });

  it('before activation: not-active with the activation point', () => {
    const later = { ...state, pool: { ...state.pool, activationPoint: now + 10n } };
    expect(quoteFromState(later, 1_000n, 0, now)).toMatchObject({
      kind: 'not-active',
      activationPoint: now + 10n,
    });
  });
});

describe('checkBaseMint', () => {
  /** Token-2022 mint: 82-byte base, zero padding to 165, account type 1, then TLV entries. */
  function mint2022(...extensions: [type: number, length: number][]): Uint8Array {
    const tlv = extensions.flatMap(([t, l]) => [
      t & 0xff,
      t >> 8,
      l & 0xff,
      l >> 8,
      ...new Array<number>(l).fill(0),
    ]);
    const out = new Uint8Array(166 + tlv.length);
    out[165] = 1;
    out.set(tlv, 166);
    return out;
  }

  it('SPL Token and Token-2022 with metadata only are supported', () => {
    expect(
      checkBaseMint('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', new Uint8Array(82)),
    ).toEqual({
      program: 'spl-token',
    });
    // MetadataPointer (18, 64 bytes) + TokenMetadata (19, 10 bytes)
    expect(checkBaseMint(TOKEN_2022, mint2022([18, 64], [19, 10]))).toEqual({
      program: 'token-2022',
    });
    // the real fixture mint
    expect(checkBaseMint(c.baseMintOwner, bytes(c.baseMintData))).toEqual({
      program: 'token-2022',
    });
  });

  it('refuses a transfer fee, a transfer hook, frozen-by-default, non-transferable and pausable mints', () => {
    expect(checkBaseMint(TOKEN_2022, mint2022([18, 64], [1, 108]))).toEqual({
      unsupported: 'transfer-fee',
    });
    expect(checkBaseMint(TOKEN_2022, mint2022([14, 64]))).toEqual({ unsupported: 'transfer-hook' });
    expect(checkBaseMint(TOKEN_2022, mint2022([6, 1]))).toEqual({
      unsupported: 'default-account-state',
    });
    expect(checkBaseMint(TOKEN_2022, mint2022([9, 0]))).toEqual({
      unsupported: 'non-transferable',
    });
    expect(checkBaseMint(TOKEN_2022, mint2022([26, 33]))).toEqual({ unsupported: 'pausable' });
  });

  it('an account of another program is not a token mint', () => {
    expect(checkBaseMint(DBC, new Uint8Array(82))).toEqual({ unsupported: 'not-a-token-mint' });
  });
});
