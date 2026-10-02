import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type RpcTransport,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ACCOUNTS_PER_CALL,
  createBalancesRpc,
  createResilientTransport,
  fetchSolBalances,
  redactUrl,
} from '../../src/chain/index.ts';
import { AppError, isAppError } from '../../src/core/errors.ts';
import { deriveWallets } from '../../src/core/index.ts';

const MNEMONIC = `${'abandon '.repeat(11)}about`;
/** Valid base58 addresses; balance of address i is i * 1000 lamports, every 7th is missing. */
const ADDRESSES = deriveWallets(MNEMONIC, 0, 100)
  .map((w) => w.address)
  .concat(deriveWallets(MNEMONIC, 0, 100).map((w) => w.address))
  .concat(deriveWallets(MNEMONIC, 0, 50).map((w) => w.address));
const BALANCE = new Map(ADDRESSES.map((a, i) => [a, BigInt(i % 100) * 1000n]));
const MISSING = new Set(ADDRESSES.filter((_, i) => i % 7 === 3));

interface Payload {
  readonly id: unknown;
  readonly method: string;
  readonly params: [string[], Record<string, unknown>];
}

/** Fake Solana RPC: answers getMultipleAccounts from BALANCE and records each call. */
function fakeTransport(lamportsOf: (a: string) => bigint | null = (a) => BALANCE.get(a) ?? 0n) {
  const calls: Payload[] = [];
  const transport = vi.fn((config: { payload: unknown }) => {
    const payload = config.payload as Payload;
    calls.push(payload);
    const value = payload.params[0].map((a) => {
      const lamports = MISSING.has(a) ? null : lamportsOf(a);
      return lamports === null
        ? null
        : {
            lamports,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
            rentEpoch: 0n,
            space: 0n,
          };
    });
    return Promise.resolve({
      jsonrpc: '2.0',
      id: payload.id,
      result: { context: { slot: 1n }, value },
    });
  });
  return { transport: transport as unknown as RpcTransport, calls };
}

function httpError(statusCode: number): SolanaError {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: 'error',
    statusCode,
  });
}

describe('fetchSolBalances', () => {
  it.each([
    [0, 0],
    [1, 1],
    [100, 1],
    [101, 2],
    [250, 3],
  ])('%i addresses → %i calls, results in input order', async (count, calls) => {
    const fake = fakeTransport();
    const input = ADDRESSES.slice(0, count);
    const result = await fetchSolBalances(createBalancesRpc(fake.transport), input);
    expect(fake.calls).toHaveLength(calls);
    expect(fake.calls.every((c) => c.method === 'getMultipleAccounts')).toBe(true);
    expect(fake.calls.every((c) => c.params[0].length <= MAX_ACCOUNTS_PER_CALL)).toBe(true);
    expect(fake.calls.flatMap((c) => c.params[0])).toEqual(input);
    expect(result).toEqual(input.map((a) => (MISSING.has(a) ? 0n : (BALANCE.get(a) ?? 0n))));
  });

  it('asks for no account data and confirmed commitment', async () => {
    const fake = fakeTransport();
    await fetchSolBalances(createBalancesRpc(fake.transport), ADDRESSES.slice(0, 2));
    expect(fake.calls[0]?.params[1]).toMatchObject({
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      commitment: 'confirmed',
    });
  });

  it('a missing account is 0n; amounts above 2^53 stay exact bigint', async () => {
    const huge = 2n ** 60n + 7n;
    const fake = fakeTransport(() => huge);
    const [missing, present] = [ADDRESSES[3] ?? '', ADDRESSES[0] ?? ''];
    expect(MISSING.has(missing)).toBe(true);
    const result = await fetchSolBalances(createBalancesRpc(fake.transport), [present, missing]);
    expect(result).toEqual([huge, 0n]);
    expect(typeof result[0]).toBe('bigint');
  });

  it('rejects an invalid address before any call', async () => {
    const fake = fakeTransport();
    await expect(
      fetchSolBalances(createBalancesRpc(fake.transport), ['not-an-address']),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('createResilientTransport', () => {
  const KEY = 'secretHeliusKey123';

  function failing(errors: Error[]) {
    const queue = [...errors];
    return vi.fn((config: { payload: unknown }) => {
      const e = queue.shift();
      if (e !== undefined) return Promise.reject(e);
      return fakeTransport().transport(config);
    }) as unknown as RpcTransport & ReturnType<typeof vi.fn>;
  }

  it.each([[429], [500], [502], [503]])(
    'HTTP %i: backoff, then success on Helius',
    async (status) => {
      const sleeps: number[] = [];
      const primary = failing([httpError(status), httpError(status)]);
      const fallback = fakeTransport();
      const sources: string[] = [];
      const transport = createResilientTransport({
        primary,
        fallback: fallback.transport,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        onSource: (s) => sources.push(s),
      });
      const result = await fetchSolBalances(createBalancesRpc(transport), ADDRESSES.slice(0, 2));
      expect(result).toHaveLength(2);
      expect(sleeps).toEqual([250, 500]);
      expect(primary).toHaveBeenCalledTimes(3);
      expect(fallback.calls).toHaveLength(0);
      expect(sources).toEqual(['helius']);
    },
  );

  it('keeps failing with 429 / 5xx: backoff 250 → 2000 ms, then the fallback answers', async () => {
    const sleeps: number[] = [];
    const primary = failing([httpError(429), httpError(503), httpError(500), httpError(429)]);
    const fallback = fakeTransport();
    const sources: string[] = [];
    const transport = createResilientTransport({
      primary,
      fallback: fallback.transport,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onSource: (s) => sources.push(s),
    });
    const result = await fetchSolBalances(createBalancesRpc(transport), ADDRESSES.slice(0, 3));
    expect(result).toHaveLength(3);
    expect(sleeps).toEqual([250, 500, 1000]);
    expect(primary).toHaveBeenCalledTimes(4);
    expect(fallback.calls).toHaveLength(1);
    expect(sources).toEqual(['fallback']);
  });

  it('a non-retryable error (401, bad key) goes to the fallback at once', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const primary = failing([httpError(401)]);
    const fallback = fakeTransport();
    const transport = createResilientTransport({ primary, fallback: fallback.transport, sleep });
    await fetchSolBalances(createBalancesRpc(transport), ADDRESSES.slice(0, 1));
    expect(sleep).not.toHaveBeenCalled();
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback.calls).toHaveLength(1);
  });

  it('network errors with the key in the URL give RPC_UNAVAILABLE without the key', async () => {
    const url = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
    const networkError = new TypeError(`fetch failed: ${url}`);
    const primary = vi.fn(() => Promise.reject(networkError)) as unknown as RpcTransport;
    const fallback = vi.fn(() =>
      Promise.reject(new TypeError(`fetch failed: ${url}`)),
    ) as unknown as RpcTransport;
    const transport = createResilientTransport({
      primary,
      fallback,
      sleep: () => Promise.resolve(),
    });
    const err: unknown = await fetchSolBalances(
      createBalancesRpc(transport),
      ADDRESSES.slice(0, 1),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(isAppError(err) && err.code).toBe('RPC_UNAVAILABLE');
    const everything = JSON.stringify(err, Object.getOwnPropertyNames(err)) + String(err);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('helius-rpc');
    expect((err as AppError).cause).toBeUndefined();
  });

  it('redactUrl drops the query with the key', () => {
    expect(redactUrl(`https://mainnet.helius-rpc.com/?api-key=${KEY}`)).toBe(
      'https://mainnet.helius-rpc.com/?…',
    );
    expect(redactUrl('https://api.mainnet.solana.com')).toBe('https://api.mainnet.solana.com/');
    expect(redactUrl('nonsense')).toBe('[nieprawidłowy URL]');
  });
});
