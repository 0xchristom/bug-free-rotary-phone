/**
 * A fleet file written by the app before BUNNDLY-58 (trade parameters) still opens and buys
 * exactly as before. Moved out of trade.test.ts in BUNNDLY-74: the fixture is a real file,
 * encrypted with real scrypt, so this file runs without the fast stand-in (fast-kdf.ts).
 */
import type { RpcTransport } from '@solana/kit';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRADE_SETTINGS, defaultFleetSettings } from '../../src/core/index.ts';
import type { ExecutorEvent } from '../../src/executor/index.ts';
import type { VaultStatus } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { MINT_ACCOUNT } from '../helpers/mint-account.ts';
import { USDC, buildTransaction } from '../helpers/tx-fakes.ts';

vi.setConfig({ testTimeout: 60_000 });

const SOL = 1_000_000_000n;

/** RPC mock for SOL balances only: every account has 1 SOL. */
const solOnly = ((config: { payload: unknown }) => {
  const payload = config.payload as { id: unknown; params: [string[]] };
  return Promise.resolve({
    jsonrpc: '2.0',
    id: payload.id,
    result: {
      context: { slot: 1n },
      // USDC is a token mint to the target check (BUNNDLY-59)
      value: payload.params[0].map((address) =>
        address === USDC
          ? MINT_ACCOUNT
          : {
              lamports: SOL,
              owner: '11111111111111111111111111111111',
              data: ['', 'base64'],
              executable: false,
              rentEpoch: 0n,
              space: 0n,
            },
      ),
    },
  });
}) as unknown as RpcTransport;

describe('a fleet file from before the change (fixture written by the app before BUNNDLY-58)', () => {
  it('opens with the default trade parameters and buys with exactly the request of before', async () => {
    const clock = new FakeClock();
    const jupiter = new FakeJupiter(clock, {
      transaction: (taker) => buildTransaction({ feePayer: taker }),
    });
    const h = createVaultHandler({
      chain: { createTransport: () => solOnly, sleep: () => Promise.resolve() },
      executor: { jupiter, clock },
      now: () => clock.now(),
      autoLockMs: 60_000,
    });
    const events: ExecutorEvent[] = [];
    h.onEvent((e) => {
      if (e.kind !== 'watch') events.push(e);
    });
    await h.handle({
      type: 'unlock',
      fileText: readFileSync('tests/fixtures/fleet-before-58.json', 'utf8'),
      password: 'fixture password 58',
    });
    const opened = (await h.handle({ type: 'status' })) as VaultStatus;
    const info = opened.info;
    expect(info?.settings.trade).toEqual(DEFAULT_TRADE_SETTINGS);
    // no groups saved: one group with both wallets, and requests may leave the group out
    expect(info?.settings.groups).toEqual([]);
    expect(opened.groups).toEqual([{ id: 'g1', armed: false, buy: null, watch: null }]);
    expect(info?.settings.maxSpend).toEqual([{ index: 0, lamports: 10_000_000n }]);
    // the Helius key goes in the way the settings screen sends it: no trade part
    await h.handle({
      type: 'saveSettings',
      settings: {
        maxSpend: info?.settings.maxSpend ?? [],
        active: [],
        global: info?.settings.global ?? defaultFleetSettings().global,
      },
      apiKeys: { helius: 'heliusFixtureKey' },
    });
    await h.handle({ type: 'refreshBalances' });
    await h.handle({ type: 'startBuy', mint: USDC });
    for (
      let i = 0;
      i < 400 && !events.some((e) => e.kind === 'run' && e.phase === 'finished');
      i++
    ) {
      await clock.runUntil();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const [request, ...more] = jupiter.orderRequests();
    expect(more).toEqual([]);
    expect(request).toEqual({
      outputMint: USDC,
      amount: 10_000_000n,
      taker: info?.wallets[0]?.address,
    });
  });
});
