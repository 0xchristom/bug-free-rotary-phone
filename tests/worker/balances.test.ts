import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type RpcTransport,
} from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_RPC_URL } from '../../src/chain/index.ts';
import { AppError, defaultFleetSettings } from '../../src/core/index.ts';
import type { VaultBalances, VaultFileResult } from '../../src/worker/protocol.ts';
import {
  createVaultHandler,
  type ChainOptions,
  type VaultHandler,
} from '../../src/worker/vault.ts';

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const KEY = 'heliusSecretKey777';
const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

interface Payload {
  readonly id: unknown;
  readonly params: [string[], unknown];
}

type Behaviour = (payload: Payload) => Promise<unknown>;

/** Mock transports per URL; `answer` gives each address 1 SOL + its position. */
function network(behaviour: Partial<Record<string, Behaviour>> = {}) {
  const urls: string[] = [];
  const answer: Behaviour = (payload) =>
    Promise.resolve({
      jsonrpc: '2.0',
      id: payload.id,
      result: {
        context: { slot: 1n },
        value: payload.params[0].map((_, i) => ({
          lamports: 1_000_000_000n + BigInt(i),
          owner: '11111111111111111111111111111111',
          data: ['', 'base64'],
          executable: false,
          rentEpoch: 0n,
          space: 0n,
        })),
      },
    });
  const chain: ChainOptions = {
    createTransport: (url) =>
      ((config: { payload: unknown }) => {
        urls.push(url);
        return (behaviour[url] ?? answer)(config.payload as Payload);
      }) as unknown as RpcTransport,
    sleep: () => Promise.resolve(),
  };
  return { chain, urls };
}

function httpError(statusCode: number): SolanaError {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: `HTTP ${String(statusCode)} for ${HELIUS_URL}`,
    statusCode,
  });
}

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function fleet(
  h: VaultHandler,
  apiKeys: Record<string, string> = { helius: KEY },
): Promise<void> {
  await h.handle({
    type: 'create',
    fleetName: 'Salda',
    walletCount: 3,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  (await h.handle({
    type: 'saveSettings',
    settings: defaultFleetSettings(),
    apiKeys,
  })) as VaultFileResult;
}

async function refresh(h: VaultHandler): Promise<VaultBalances> {
  return (await h.handle({ type: 'refreshBalances' })) as VaultBalances;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : 'not an AppError'),
  );
}

describe('refreshBalances in the vault worker', () => {
  it('reads balances through Helius with the stored key; the answer has no key or URL', async () => {
    const net = network();
    const h = createVaultHandler({ chain: net.chain });
    await fleet(h);
    const res = await refresh(h);
    expect(net.urls).toEqual([HELIUS_URL]);
    expect(res.source).toBe('helius');
    expect(res.balances).toEqual([
      { index: 0, lamports: 1_000_000_000n },
      { index: 1, lamports: 1_000_000_001n },
      { index: 2, lamports: 1_000_000_002n },
    ]);
    const text = JSON.stringify(res, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('helius-rpc');
    expect(Object.keys(res).sort()).toEqual(['balances', 'fetchedAt', 'source']);
  });

  it('a custom RPC URL wins over the key', async () => {
    const custom = 'https://rpc.example.com/?api-key=own';
    const net = network();
    const h = createVaultHandler({ chain: net.chain });
    await fleet(h, { helius: KEY, heliusRpcUrl: custom });
    await refresh(h);
    expect(net.urls).toEqual([custom]);
  });

  it('without a Helius key: HELIUS_KEY_MISSING and no network call', async () => {
    const net = network();
    const h = createVaultHandler({ chain: net.chain });
    await fleet(h, {});
    expect(await codeOf(refresh(h))).toBe('HELIUS_KEY_MISSING');
    expect(net.urls).toEqual([]);
  });

  it('while locked: VAULT_LOCKED and no network call', async () => {
    const net = network();
    const h = createVaultHandler({ chain: net.chain });
    expect(await codeOf(refresh(h))).toBe('VAULT_LOCKED');
    expect(net.urls).toEqual([]);
  });

  it('Helius 429/5xx: retries, then the public RPC; the UI learns about the fallback', async () => {
    const net = network({ [HELIUS_URL]: () => Promise.reject(httpError(503)) });
    const h = createVaultHandler({ chain: net.chain });
    await fleet(h);
    const res = await refresh(h);
    expect(res.source).toBe('fallback');
    expect(net.urls).toEqual([HELIUS_URL, HELIUS_URL, HELIUS_URL, HELIUS_URL, PUBLIC_RPC_URL]);
    expect(res.balances).toHaveLength(3);
  });

  it('both down: RPC_UNAVAILABLE whose message and fields do not contain the key', async () => {
    const down: Behaviour = () => Promise.reject(new TypeError(`fetch failed ${HELIUS_URL}`));
    const net = network({ [HELIUS_URL]: down, [PUBLIC_RPC_URL]: down });
    const h = createVaultHandler({ chain: net.chain });
    await fleet(h);
    const err: unknown = await refresh(h).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('RPC_UNAVAILABLE');
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(KEY);
  });

  it('periodic refreshes do not reset the auto-lock timer (fake clock)', async () => {
    const c = clock();
    const h = createVaultHandler({ now: c.now, autoLockMs: 60_000, chain: network().chain });
    await fleet(h); // last real activity at t = 0
    for (let i = 0; i < 4; i++) {
      c.advance(12_000); // the UI refreshes every 12 s
      await refresh(h);
      expect(h.checkAutoLock()).toBe(false);
    }
    c.advance(12_000); // t = 60 s
    expect(h.checkAutoLock()).toBe(true);
    expect(await codeOf(refresh(h))).toBe('VAULT_LOCKED');
  });

  it('a refresh just before the limit does not keep the vault unlocked', async () => {
    const c = clock();
    const h = createVaultHandler({ now: c.now, autoLockMs: 60_000, chain: network().chain });
    await fleet(h);
    c.advance(59_999);
    await refresh(h);
    c.advance(1);
    expect(h.checkAutoLock()).toBe(true);
  });

  it('a slow read does not hold up lock; its result is then refused', async () => {
    let release: () => void = () => undefined;
    const slow: Behaviour = (payload) =>
      new Promise((resolve) => {
        release = () => {
          resolve({
            jsonrpc: '2.0',
            id: payload.id,
            result: { context: { slot: 1n }, value: payload.params[0].map(() => null) },
          });
        };
      });
    const net = network({ [HELIUS_URL]: slow });
    const h = createVaultHandler({ chain: net.chain });
    await fleet(h);
    const pending = codeOf(refresh(h));
    await vi.waitFor(() => {
      expect(net.urls).toHaveLength(1);
    });
    const status = (await h.handle({ type: 'lock' })) as { locked: boolean };
    expect(status.locked).toBe(true);
    release();
    expect(await pending).toBe('VAULT_LOCKED');
  });
});
