/**
 * Token balances against real mainnet accounts (tests/fixtures/token-accounts.mainnet.json,
 * read through Helius; slot and source are in the file). No network: a fake transport
 * serves the stored accounts and honours `dataSlice` like the RPC does.
 */
import { readFileSync } from 'node:fs';
import { base64 } from '@scure/base';
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  MINT_SIZE,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  createBalancesRpc,
  fetchTokenBalances,
  findAssociatedTokenAddress,
  parseMint,
  readU64LE,
} from '../../src/chain/index.ts';
import { AppError, ERROR_MESSAGES } from '../../src/core/errors.ts';

interface StoredAccount {
  readonly owner: string;
  readonly lamports: string;
  readonly data: string;
  readonly executable: boolean;
  readonly space: number;
}

interface Fixture {
  readonly slot: number;
  readonly spl: { mint: string; owner: string; ata: string };
  readonly token2022: { mint: string; owner: string; ata: string };
  readonly missing: { owner: string; mint: string; ata: string };
  readonly fundedBeforeCreation: { slot: number; owner: string; mint: string; ata: string };
  readonly accounts: Record<string, StoredAccount | null>;
  readonly expected: {
    splDecimals: number;
    token2022Decimals: number;
    splAtaAmount: string;
    token2022AtaAmount: string;
    splAtaOwner: string;
    token2022AtaOwner: string;
    token2022AtaExtensions: string[];
  };
}

const F = JSON.parse(
  readFileSync(new URL('../fixtures/token-accounts.mainnet.json', import.meta.url), 'utf8'),
) as Fixture;

function stored(address: string): StoredAccount {
  const a = F.accounts[address];
  if (!a) throw new Error(`no fixture for ${address}`);
  return a;
}

interface Payload {
  readonly id: unknown;
  readonly method: string;
  readonly params: [string[], { dataSlice?: { offset: number; length: number } }];
}

/** Serves fixture accounts; unknown addresses do not exist. Records every call. */
function fixtureTransport(overrides: Record<string, StoredAccount | null> = {}) {
  const calls: Payload[] = [];
  const transport = (config: { payload: unknown }) => {
    const payload = config.payload as Payload;
    calls.push(payload);
    const slice = payload.params[1].dataSlice;
    const value = payload.params[0].map((addr) => {
      const acc = addr in overrides ? overrides[addr] : F.accounts[addr];
      if (!acc) return null;
      let data = base64.decode(acc.data);
      if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
      return {
        owner: acc.owner,
        lamports: BigInt(acc.lamports),
        data: [base64.encode(data), 'base64'],
        executable: acc.executable,
        rentEpoch: 0n,
        space: BigInt(acc.space),
      };
    });
    return Promise.resolve({
      jsonrpc: '2.0',
      id: payload.id,
      result: { context: { slot: BigInt(F.slot) }, value },
    });
  };
  return { rpc: createBalancesRpc(transport as unknown as RpcTransport), calls };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
}

describe('fixtures (mainnet, via Helius)', () => {
  it('cover an SPL mint, a Token-2022 mint with extensions and ATAs of both kinds', () => {
    expect(stored(F.spl.mint).owner).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(stored(F.token2022.mint).owner).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(stored(F.token2022.mint).space).toBeGreaterThan(MINT_SIZE); // has extensions
    expect(stored(F.spl.ata).owner).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(stored(F.token2022.ata).owner).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(F.expected.token2022AtaExtensions.length).toBeGreaterThan(0);
    expect(F.accounts[F.missing.ata]).toBeNull();
    expect(F.slot).toBeGreaterThan(0);
  });
});

describe('findAssociatedTokenAddress', () => {
  it.each([
    ['SPL Token', () => F.spl, 'spl-token'],
    ['Token-2022', () => F.token2022, 'token-2022'],
  ] as const)('%s: derived ATA equals the mainnet account', async (_label, get, program) => {
    const f = get();
    expect(await findAssociatedTokenAddress(f.owner, f.mint, program)).toBe(f.ata);
  });

  it('the same owner and mint under the other program gives a different address', async () => {
    const other = await findAssociatedTokenAddress(F.spl.owner, F.spl.mint, 'token-2022');
    expect(other).not.toBe(F.spl.ata);
  });
});

describe('parseMint', () => {
  it('reads program and decimals of the SPL and Token-2022 mints', () => {
    const spl = stored(F.spl.mint);
    const t22 = stored(F.token2022.mint);
    expect(parseMint(spl.owner, base64.decode(spl.data))).toEqual({
      program: 'spl-token',
      decimals: F.expected.splDecimals,
    });
    expect(parseMint(t22.owner, base64.decode(t22.data))).toEqual({
      program: 'token-2022',
      decimals: F.expected.token2022Decimals,
    });
  });

  it.each<[string, () => [string, Uint8Array]]>([
    [
      'owner is the System Program (a wallet)',
      () => ['11111111111111111111111111111111', new Uint8Array(0)],
    ],
    [
      'owner is an unknown program',
      () => ['Vote111111111111111111111111111111111111111', base64.decode(stored(F.spl.mint).data)],
    ],
    [
      'an SPL token account, not a mint',
      () => [TOKEN_PROGRAM_ADDRESS, base64.decode(stored(F.spl.ata).data)],
    ],
    [
      'a Token-2022 token account with extensions',
      () => [TOKEN_2022_PROGRAM_ADDRESS, base64.decode(stored(F.token2022.ata).data)],
    ],
    [
      'an uninitialized mint',
      () => {
        const data = base64.decode(stored(F.spl.mint).data);
        data[45] = 0;
        return [TOKEN_PROGRAM_ADDRESS, data];
      },
    ],
  ])('%s → NOT_A_TOKEN_MINT', (_label, make) => {
    const [owner, data] = make();
    expect(() => parseMint(owner, data)).toThrow(ERROR_MESSAGES.NOT_A_TOKEN_MINT);
  });
});

describe('readU64LE', () => {
  it('is exact above 2^53 and matches the amounts parsed by Helius', () => {
    const bytes = new Uint8Array(8).fill(0xff);
    expect(readU64LE(bytes, 0)).toBe(2n ** 64n - 1n);
    expect(readU64LE(base64.decode(stored(F.spl.ata).data), 64)).toBe(
      BigInt(F.expected.splAtaAmount),
    );
    expect(readU64LE(base64.decode(stored(F.token2022.ata).data), 64)).toBe(
      BigInt(F.expected.token2022AtaAmount),
    );
  });
});

describe('fetchTokenBalances', () => {
  it('SPL: decimals from the mint, the existing ATA amount, a missing ATA is 0n', async () => {
    const { rpc, calls } = fixtureTransport();
    const res = await fetchTokenBalances(rpc, F.spl.mint, [F.spl.owner, F.missing.owner]);
    expect(res).toEqual({
      mint: F.spl.mint,
      program: 'spl-token',
      decimals: 6,
      amounts: [BigInt(F.expected.splAtaAmount), 0n],
      slot: BigInt(F.slot),
    });
    // one call for the mint, one batch for the ATAs, which asks only for the base prefix
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params[0]).toEqual([F.spl.ata, F.missing.ata]);
    expect(calls[1]?.params[1].dataSlice).toEqual({ offset: 0, length: 72 });
  });

  it('Token-2022 with extensions: amount read from the base part', async () => {
    const { rpc } = fixtureTransport();
    const res = await fetchTokenBalances(rpc, F.token2022.mint, [F.token2022.owner]);
    expect(res.program).toBe('token-2022');
    expect(res.decimals).toBe(6);
    expect(res.amounts).toEqual([BigInt(F.expected.token2022AtaAmount)]);
  });

  it('an ATA funded with SOL before creation (System account, no data) is 0n, in order', async () => {
    const funded = F.fundedBeforeCreation;
    const state = stored(funded.ata);
    expect(state.owner).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(state.space).toBe(0);
    expect(BigInt(state.lamports)).toBeGreaterThan(0n);
    expect(await findAssociatedTokenAddress(funded.owner, funded.mint, 'token-2022')).toBe(
      funded.ata,
    );

    const { rpc, calls } = fixtureTransport();
    const res = await fetchTokenBalances(rpc, F.token2022.mint, [
      F.token2022.owner, // existing ATA
      funded.owner, // funded before creation
      F.missing.owner, // no account at all
    ]);
    expect(res.amounts).toEqual([BigInt(F.expected.token2022AtaAmount), 0n, 0n]);
    expect(calls).toHaveLength(2); // mint + one ATA batch
    expect(calls[1]?.params[0][1]).toBe(funded.ata);
  });

  it.each<[string, StoredAccount]>([
    [
      'a System account with data',
      { owner: SYSTEM_PROGRAM_ADDRESS, lamports: '1', data: 'AAAA', executable: false, space: 3 },
    ],
    [
      'an account of another program',
      { ...stored(F.spl.mint), owner: 'Vote111111111111111111111111111111111111111' },
    ],
    ['a token account of another mint', stored(F.spl.ata)],
  ])('%s at an ATA address → INTERNAL_ERROR (not a network error)', async (_label, account) => {
    const { rpc } = fixtureTransport({ [F.token2022.ata]: account });
    expect(await codeOf(fetchTokenBalances(rpc, F.token2022.mint, [F.token2022.owner]))).toBe(
      'INTERNAL_ERROR',
    );
  });

  it('250 owners: ATAs in 3 batches, order kept', async () => {
    const { rpc, calls } = fixtureTransport();
    const owners = Array.from({ length: 250 }, (_, i) =>
      i === 137 ? F.spl.owner : F.missing.owner,
    );
    const res = await fetchTokenBalances(rpc, F.spl.mint, owners);
    expect(calls).toHaveLength(1 + 3);
    expect(res.amounts.filter((a) => a > 0n)).toEqual([BigInt(F.expected.splAtaAmount)]);
    expect(res.amounts[137]).toBe(BigInt(F.expected.splAtaAmount));
  });

  it.each<[string, string, Record<string, StoredAccount | null>]>([
    ['a wallet address (System Program)', '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4', {}],
    ['a token account instead of a mint', F.spl.ata, {}],
    ['an account that does not exist', F.missing.ata, {}],
    ['an invalid address', 'not-a-mint', {}],
  ])('%s → NOT_A_TOKEN_MINT (Polish message), no ATA reads', async (_label, mint, overrides) => {
    const { rpc, calls } = fixtureTransport(overrides);
    expect(await codeOf(fetchTokenBalances(rpc, mint, [F.spl.owner]))).toBe('NOT_A_TOKEN_MINT');
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(ERROR_MESSAGES.NOT_A_TOKEN_MINT).toContain('nie jest mintem tokenu');
  });
});
