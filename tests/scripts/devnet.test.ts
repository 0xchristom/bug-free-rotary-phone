import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVNET_GENESIS_HASH,
  DevnetError,
  INITIALIZE_POOL_SPL_DISCRIMINATOR,
  buyRow,
  createRpc,
  initializeDbcPool,
  loadKeypairFile,
  openDevnet,
  transfer,
  type ChainTx,
  type Fetch,
} from '../../scripts/devnet/lib.ts';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

function fakeRpc(genesis: string) {
  const methods: string[] = [];
  const fetchFn: Fetch = (_url, init) => {
    const { method } = JSON.parse(init.body as string) as { method: string };
    methods.push(method);
    const result =
      method === 'getGenesisHash'
        ? genesis
        : method === 'getLatestBlockhash'
          ? {
              value: {
                blockhash: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                lastValidBlockHeight: 1,
              },
            }
          : method === 'sendTransaction'
            ? 'sig'
            : { value: [{ slot: 7, err: null, confirmationStatus: 'confirmed' }] };
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result })));
  };
  return { rpc: createRpc('http://rpc.test', fetchFn), methods };
}

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('devnet guard (BUNNDLY-49)', () => {
  it('refuses a cluster whose genesis hash is not devnet and sends nothing', async () => {
    const { rpc, methods } = fakeRpc(MAINNET_GENESIS);
    await expect(openDevnet(rpc)).rejects.toThrow(/not devnet/);
    expect(methods).toEqual(['getGenesisHash']);
  });

  it('opens on the devnet hash, and only then can a transfer be signed and sent', async () => {
    const { rpc, methods } = fakeRpc(DEVNET_GENESIS_HASH);
    const devnet = await openDevnet(rpc);
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    const bytes = [
      ...Buffer.from(jwk.d ?? '', 'base64url'),
      ...Buffer.from(jwk.x ?? '', 'base64url'),
    ];
    dir = await mkdtemp(join(tmpdir(), 'bunndly-devnet-'));
    const file = join(dir, 'k.json');
    await writeFile(file, JSON.stringify(bytes));
    const wallet = await loadKeypairFile(file);
    const sent = await devnet.send([transfer(wallet.address, wallet.address, 1n)], [wallet]);
    expect(sent.slot).toBe(7);
    expect(methods).toEqual([
      'getGenesisHash',
      'getLatestBlockhash',
      'sendTransaction',
      'getSignatureStatuses',
    ]);
  });

  it('never quotes the keypair file in its errors', async () => {
    dir = await mkdtemp(join(tmpdir(), 'bunndly-devnet-'));
    const file = join(dir, 'k.json');
    const secretish = JSON.stringify(Array.from({ length: 63 }, (_, i) => i + 100));
    await writeFile(file, secretish);
    const err: unknown = await loadKeypairFile(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevnetError);
    expect((err as Error).message).toBe(
      'the file in BUNNDLY_DEVNET_KEYPAIR is not a 64-byte Solana CLI keypair',
    );
    expect((err as Error).message).not.toContain('100');
    await expect(loadKeypairFile(undefined)).rejects.toThrow('BUNNDLY_DEVNET_KEYPAIR is not set');
  });
});

describe('initialize_virtual_pool_with_spl_token', () => {
  it('has the IDL discriminator, Borsh strings and 16 accounts with three signers', async () => {
    const ix = await initializeDbcPool({
      config: 'AkKLsP5gRZ6NopNyDmwPEr7z9Bwwrao8irCUZ9Rx3J7D',
      creator: '7kFnnRYboLuon81UF8LmTHTz1dnxFYM4ZnyivLAoN2qS',
      baseMint: 'gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB',
      payer: '7kFnnRYboLuon81UF8LmTHTz1dnxFYM4ZnyivLAoN2qS',
      name: 'AB',
      symbol: 'C',
      uri: '',
    });
    // 8 discriminator + (4 + 2) + (4 + 1) + (4 + 0), counted by hand
    expect([...(ix.data ?? [])]).toEqual([
      ...INITIALIZE_POOL_SPL_DISCRIMINATOR,
      2,
      0,
      0,
      0,
      65,
      66,
      1,
      0,
      0,
      0,
      67,
      0,
      0,
      0,
      0,
    ]);
    expect(ix.accounts).toHaveLength(16);
    expect(ix.accounts?.[1]?.address).toBe('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
  });
});

describe('buyRow', () => {
  it('reads slot - S0, SOL spent and token growth of the wallet from the transaction', () => {
    const wallet = 'gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB';
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const tx: ChainTx = {
      slot: 101,
      blockTime: null,
      transaction: { message: { accountKeys: ['other', wallet] } },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [0, 1_000_000_000],
        postBalances: [0, 988_506_560],
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 2, mint, owner: wallet, uiTokenAmount: { amount: '42' } },
        ],
      },
    };
    expect(buyRow(wallet, mint, 's', 100, tx)).toEqual({
      wallet,
      signature: 's',
      slot: 101,
      deltaS0: 1,
      ok: true,
      solSpent: 11_493_440n,
      fee: 5000n,
      tokensReceived: 42n,
    });
  });
});
