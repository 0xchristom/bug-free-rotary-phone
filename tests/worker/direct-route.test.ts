/**
 * The vault picks the route from the fleet's network alone (BUNNDLY-48; sells BUNNDLY-63):
 * devnet buys and sells through the direct Meteora DBC route and never asks Jupiter;
 * mainnet asks Jupiter and never the direct route, and a direct order forced into the
 * signer there is refused.
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { defaultFleetSettings, type FleetSettingsV1 } from '../../src/core/index.ts';
import { DIRECT_ROUTER } from '../../src/direct/route.ts';
import { SOL_MINT } from '../../src/jupiter/client.ts';
import type { ExecutorEvent, WalletEvent } from '../../src/executor/index.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { MINT_ACCOUNT } from '../helpers/mint-account.ts';
import { USDC, buildTransaction, orderFor } from '../helpers/tx-fakes.ts';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const MAX = 10_000_000n;
/** Token units each wallet holds in the sell tests. */
const HELD = 5_000_000n;

/** Every wallet 1 SOL; USDC is a token mint. Records the URL of every RPC call. */
function chainOf(urls: string[]) {
  return {
    createTransport: (url: string) =>
      ((config: { payload: unknown }) => {
        urls.push(url);
        const payload = config.payload as { id: unknown; params: [string[]] };
        return Promise.resolve({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            context: { slot: 1n },
            value: payload.params[0].map((account) =>
              account === USDC
                ? MINT_ACCOUNT
                : {
                    lamports: 1_000_000_000n,
                    owner: '11111111111111111111111111111111',
                    data: ['', 'base64'],
                    executable: false,
                    rentEpoch: 0n,
                    space: 0n,
                  },
            ),
          },
        });
      }) as unknown as RpcTransport,
    sleep: () => Promise.resolve(),
  };
}

async function setup(
  network: 'mainnet' | 'devnet',
  o: { heliusKey?: boolean; dryRun?: boolean; tokens?: boolean } = {},
) {
  const clock = new FakeClock();
  const transaction = (taker: string) => buildTransaction({ feePayer: taker });
  const jupiter = new FakeJupiter(clock, { transaction });
  const direct = new FakeJupiter(clock, { transaction });
  const urls: string[] = [];
  // The sell tests read token balances here; the buy tests leave it to the RPC.
  const tokens = (owners: readonly string[]) =>
    Promise.resolve({ amounts: owners.map(() => HELD), slot: 1n });
  const h = createVaultHandler({
    chain: chainOf(urls),
    executor: { jupiter, direct, clock, ...(o.tokens === true ? { tokens } : {}) },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: ExecutorEvent[] = [];
  h.onEvent((e) => {
    if (e.kind === 'wallet') events.push(e);
  });
  await h.handle({
    type: 'create',
    fleetName: 'Route',
    walletCount: 2,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  const settings: FleetSettingsV1 = {
    ...base,
    maxSpend: [
      { index: 0, lamports: MAX },
      { index: 1, lamports: MAX },
    ],
    global: { ...base.global, network, dryRun: o.dryRun ?? true },
  };
  await h.handle({
    type: 'saveSettings',
    settings,
    ...(o.heliusKey === false ? {} : { apiKeys: { helius: 'heliusRouteKey' } }),
  });
  // Without a key mainnet reads nothing (D-057); devnet reads through its public RPC.
  await h.handle({ type: 'refreshBalances' }).catch(() => undefined);
  const buy = async () => {
    await h.handle({ type: 'startBuy', mint: USDC, wallets: [0, 1] });
    await clock.runUntil();
  };
  const sell = async () => {
    await h.handle({ type: 'startSell', mint: USDC, wallets: [0, 1], percent: 100 });
    await clock.runUntil();
  };
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => (e as { code?: string }).code ?? 'THROWN',
    );
  return { clock, jupiter, direct, h, events, urls, buy, sell, codeOf };
}

const finalReasons = (events: ExecutorEvent[]) =>
  events
    .filter((e): e is WalletEvent => e.kind === 'wallet' && ['FAILED', 'SKIPPED'].includes(e.state))
    .map((e) => e.reason);

describe('buy route by network', () => {
  it('mainnet with default settings: Jupiter only, zero calls to the direct route', async () => {
    const t = await setup('mainnet');
    await t.buy();
    expect(t.jupiter.calls.length).toBeGreaterThan(0);
    expect(t.direct.calls).toHaveLength(0);
  });

  it('devnet: the direct route only, zero calls to Jupiter', async () => {
    const t = await setup('devnet');
    await t.buy();
    expect(t.direct.calls.length).toBeGreaterThan(0);
    expect(t.jupiter.calls).toHaveLength(0);
  });

  it('devnet signs only a checked DBC buy: a Jupiter-like transaction is refused', async () => {
    const t = await setup('devnet');
    await t.buy();
    // The fake's transaction is a bare System instruction, not a DBC buy.
    expect(finalReasons(t.events)).toEqual([
      { kind: 'FAILED', code: 'CHECK_FAILED', detail: 'TRANSFER_MISMATCH' },
      { kind: 'FAILED', code: 'CHECK_FAILED', detail: 'TRANSFER_MISMATCH' },
    ]);
  });

  it('mainnet: a direct-route order forced into the signer is refused, the key unused', async () => {
    const t = await setup('mainnet');
    const taker = t.h.inspect().unlocked?.publicWallets[0]?.address ?? '';
    const forced = orderFor(taker, buildTransaction({ feePayer: taker }), {
      router: DIRECT_ROUTER,
    });
    expect(await t.h.signOrder(0, { outputMint: USDC, amount: MAX }, forced)).toEqual({
      ok: false,
      problem: 'DIRECT_ROUTE_OFF',
    });
    // The same order with Jupiter's router passes the Jupiter checks and is signed.
    const normal = await t.h.signOrder(
      0,
      { outputMint: USDC, amount: MAX },
      { ...forced, router: 'metis' },
    );
    expect(normal.ok).toBe(true);
  });

  it('mainnet sell with default settings: Jupiter only, zero calls to the direct route', async () => {
    const t = await setup('mainnet', { tokens: true });
    await t.sell();
    expect(t.jupiter.orderRequests().map((r) => [r.inputMint, r.amount])).toEqual([
      [USDC, HELD],
      [USDC, HELD],
    ]);
    expect(t.direct.calls).toHaveLength(0);
  });

  it('devnet sell: the direct route only, token → SOL, zero calls to Jupiter', async () => {
    const t = await setup('devnet', { tokens: true });
    await t.sell();
    expect(t.direct.orderRequests().map((r) => [r.inputMint, r.outputMint, r.amount])).toEqual([
      [USDC, SOL_MINT, HELD],
      [USDC, SOL_MINT, HELD],
    ]);
    expect(t.jupiter.calls).toHaveLength(0);
  });

  it('devnet signs only a checked DBC sell: a Jupiter-like transaction is refused', async () => {
    const t = await setup('devnet', { tokens: true });
    await t.sell();
    // The fake's transaction is a bare System instruction, not a DBC sell.
    expect(finalReasons(t.events)).toEqual([
      { kind: 'FAILED', code: 'CHECK_FAILED', detail: 'TRANSFER_MISMATCH' },
      { kind: 'FAILED', code: 'CHECK_FAILED', detail: 'TRANSFER_MISMATCH' },
    ]);
  });

  it('live sell on devnet without a Helius key: not refused, the public devnet RPC carries it', async () => {
    const t = await setup('devnet', { heliusKey: false, dryRun: false });
    expect(
      await t.codeOf(t.h.handle({ type: 'startSell', mint: USDC, wallets: [0, 1], percent: 100 })),
    ).toBeNull();
    await t.clock.runUntil();
    expect(t.urls.length).toBeGreaterThan(0);
    expect(t.urls.every((u) => u === 'https://api.devnet.solana.com')).toBe(true);
  });

  it('live on devnet without a Helius key: the public devnet RPC carries the run', async () => {
    const t = await setup('devnet', { heliusKey: false, dryRun: false });
    expect(
      await t.codeOf(t.h.handle({ type: 'startBuy', mint: USDC, wallets: [0, 1] })),
    ).toBeNull();
    await t.clock.runUntil();
    expect(t.urls.every((u) => u === 'https://api.devnet.solana.com')).toBe(true);
  });

  it('live on mainnet without a Helius key is still refused', async () => {
    const t = await setup('mainnet', { heliusKey: false, dryRun: false });
    expect(await t.codeOf(t.h.handle({ type: 'startBuy', mint: USDC, wallets: [0, 1] }))).toBe(
      'HELIUS_KEY_MISSING',
    );
  });
});
