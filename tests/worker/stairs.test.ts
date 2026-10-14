/**
 * Stairs in the vault worker (BUNNDLY-61): the request's parameters reach the executor for
 * a buy and a sell, bad ones are refused before anything starts, and pauseStairs / resumeStairs act on
 * the named group's run. Real vault and signing, fake Jupiter and clock, DRY-RUN.
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { AppError, defaultFleetSettings, type FleetSettingsV1 } from '../../src/core/index.ts';
import type { ExecutorEvent, RunEvent } from '../../src/executor/index.ts';
import type { BuyStatus, VaultStatus } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { MINT_ACCOUNT } from '../helpers/mint-account.ts';
import { USDC, buildTransaction } from '../helpers/tx-fakes.ts';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });

const MAX = 10_000_000n;
const S = 1_000;

/** RPC mock: every account has 1 SOL; USDC is a token mint. */
const chain = {
  createTransport: () =>
    ((config: { payload: unknown }) => {
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

async function setup() {
  const clock = new FakeClock();
  const jupiter = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
  });
  const h = createVaultHandler({
    chain,
    executor: {
      jupiter,
      clock,
      tokens: (owners) => Promise.resolve({ amounts: owners.map(() => 5_000_000n), slot: 1n }),
    },
    now: () => clock.now(),
    autoLockMs: 10 * 60_000,
  });
  const events: ExecutorEvent[] = [];
  h.onEvent((e) => {
    // Watcher and live balance events are not the executor's (BUNNDLY-57)
    if (e.kind !== 'watch' && e.kind !== 'balance') events.push(e);
  });
  await h.handle({
    type: 'create',
    fleetName: 'Schody',
    walletCount: 3,
    password: 'correct horse battery staple',
    mnemonic: `${'abandon '.repeat(11)}about`,
  });
  const base = defaultFleetSettings();
  const settings: FleetSettingsV1 = {
    ...base,
    maxSpend: [0, 1, 2].map((index) => ({ index, lamports: MAX })),
  };
  await h.handle({ type: 'saveSettings', settings, apiKeys: { helius: 'heliusStairsKey' } });
  await h.handle({ type: 'refreshBalances' });
  const addresses = h.inspect().unlocked?.publicWallets.map((w) => w.address) ?? [];
  const t0 = clock.now();
  /** Start of each wallet's first `/order`, ms after the request. */
  const firstOrders = (): (number | undefined)[] =>
    addresses.map((a) => {
      const call = jupiter.calls.find((c) => c.kind === 'order' && c.taker === a);
      return call === undefined ? undefined : call.start - t0;
    });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  return { clock, jupiter, h, events, firstOrders, status, t0 };
}

async function runToEnd(clock: FakeClock, events: readonly ExecutorEvent[]): Promise<void> {
  const finished = () => events.some((e) => e.kind === 'run' && e.phase === 'finished');
  for (let i = 0; i < 400 && !finished(); i++) {
    await clock.runUntil();
    if (!finished()) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
  if (!finished()) throw new Error('the run did not finish');
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.code : 'other'),
  );
}

const STAIRS = { intervalMs: 10 * S, perStep: 1 };

describe('startBuy and startSell with Stairs', () => {
  it('a buy every 10 s, 1 per step: first /order at 0, 10 and 20 s', async () => {
    const { clock, h, events, firstOrders } = await setup();
    const started = (await h.handle({
      type: 'startBuy',
      mint: USDC,
      wallets: [0, 1, 2],
      stairs: STAIRS,
    })) as BuyStatus;
    expect(started.stairs).toEqual(STAIRS);
    expect(started.paused).toBe(false);
    await runToEnd(clock, events);
    expect(firstOrders()).toEqual([0, 10_000, 20_000]);
  });

  it('a sell every 10 s, 2 per step: first /order at 0, 0.1 (behind the probe) and 10 s', async () => {
    const { clock, h, events, firstOrders } = await setup();
    await h.handle({
      type: 'startSell',
      mint: USDC,
      wallets: [0, 1, 2],
      stairs: { intervalMs: 10 * S, perStep: 2 },
    });
    await runToEnd(clock, events);
    expect(firstOrders()).toEqual([0, 100, 10_000]);
  });

  it('without stairs a buy is Immediate: no stairs in the status, all at once', async () => {
    const { clock, h, events, firstOrders } = await setup();
    const started = (await h.handle({
      type: 'startBuy',
      mint: USDC,
      wallets: [0, 1, 2],
    })) as BuyStatus;
    expect(started.stairs).toBeUndefined();
    await runToEnd(clock, events);
    expect(firstOrders()).toEqual([0, 100, 100]);
  });

  it('bad parameters are refused before anything starts', async () => {
    const { h, jupiter } = await setup();
    const bad: unknown[] = [
      { intervalMs: 999, perStep: 1 },
      { intervalMs: 24 * 60 * 60 * S + 1, perStep: 1 },
      { intervalMs: 10 * S, perStep: 0 },
      { intervalMs: 10 * S, perStep: 1.5 },
      { intervalMs: 1_500.5, perStep: 1 },
      { intervalMs: '10000', perStep: 1 },
    ];
    for (const stairs of bad) {
      expect(
        await codeOf(h.handle({ type: 'startBuy', mint: USDC, wallets: [0], stairs })),
        JSON.stringify(stairs),
      ).toBe('INVALID_STAIRS');
      expect(await codeOf(h.handle({ type: 'startSell', mint: USDC, wallets: [0], stairs }))).toBe(
        'INVALID_STAIRS',
      );
    }
    expect(jupiter.calls).toEqual([]);
  });

  it('the edges are allowed: a step every 1 s and every 24 h', async () => {
    for (const intervalMs of [1 * S, 24 * 60 * 60 * S]) {
      const { clock, h, events, firstOrders } = await setup();
      const started = (await h.handle({
        type: 'startBuy',
        mint: USDC,
        wallets: [0, 1],
        stairs: { intervalMs, perStep: 1 },
      })) as BuyStatus;
      expect(started.stairs?.intervalMs).toBe(intervalMs);
      await runToEnd(clock, events);
      expect(firstOrders()).toEqual([0, intervalMs, undefined]);
    }
  });
});

describe('pauseStairs and resumeStairs requests', () => {
  it('pause holds the next step and shows in the status; resume moves it by the pause', async () => {
    const { clock, h, events, firstOrders, status, t0 } = await setup();
    await h.handle({ type: 'startBuy', mint: USDC, wallets: [0, 1, 2], stairs: STAIRS });
    await clock.runUntil(t0 + 12_000);
    const paused = (await h.handle({ type: 'pauseStairs' })) as VaultStatus;
    expect(paused.buy?.paused).toBe(true);
    await clock.runUntil(t0 + 42_000);
    expect((await status()).buy?.paused).toBe(true);
    const resumed = (await h.handle({ type: 'resumeStairs' })) as VaultStatus;
    expect(resumed.buy?.paused).toBe(false);
    await runToEnd(clock, events);
    // Step 3 at 20 s moves by the 30 s pause to 50 s.
    expect(firstOrders()).toEqual([0, 10_000, 50_000]);
    const phases = events
      .filter((e): e is RunEvent => e.kind === 'run')
      .map((e) => e.phase)
      .filter((p) => p === 'paused' || p === 'resumed');
    expect(phases).toEqual(['paused', 'resumed']);
  });

  it('pause of an Immediate run changes nothing', async () => {
    const { clock, h, events, firstOrders } = await setup();
    await h.handle({ type: 'startBuy', mint: USDC, wallets: [0, 1, 2] });
    const after = (await h.handle({ type: 'pauseStairs' })) as VaultStatus;
    expect(after.buy?.paused).toBeUndefined();
    await runToEnd(clock, events);
    expect(firstOrders()).toEqual([0, 100, 100]);
  });
});
