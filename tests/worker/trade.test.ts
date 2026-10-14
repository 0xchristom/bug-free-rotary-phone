/**
 * Trade parameters in the vault worker (BUNNDLY-58): a percent buy amount from the last
 * balance read, slippage per side into /order, and the worker's own validation. Real
 * vault and signing, fake Jupiter and clock; every expected amount is worked out by hand.
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  DEFAULT_TRADE_SETTINGS,
  defaultFleetSettings,
  type FleetSettingsV1,
  type TradeSettingsV1,
} from '../../src/core/index.ts';
import type { ExecutorEvent, WalletEvent } from '../../src/executor/index.ts';
import type { VaultStatus } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { USDC, buildTransaction } from '../helpers/tx-fakes.ts';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const SOL = 1_000_000_000n;

async function setup(walletCount = 3) {
  /** SOL balance by address; 1 SOL when not set. */
  const lamports = new Map<string, bigint>();
  const chain = {
    createTransport: () =>
      ((config: { payload: unknown }) => {
        const payload = config.payload as { id: unknown; params: [string[]] };
        return Promise.resolve({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            context: { slot: 1n },
            value: payload.params[0].map((address) => ({
              lamports: lamports.get(address) ?? SOL,
              owner: '11111111111111111111111111111111',
              data: ['', 'base64'],
              executable: false,
              rentEpoch: 0n,
              space: 0n,
            })),
          },
        });
      }) as unknown as RpcTransport,
    sleep: () => Promise.resolve(),
  };
  const clock = new FakeClock();
  const jupiter = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
  });
  const h = createVaultHandler({
    chain,
    executor: { jupiter, clock },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: ExecutorEvent[] = [];
  h.onEvent((e) => {
    if (e.kind !== 'watch') events.push(e);
  });
  await h.handle({
    type: 'create',
    fleetName: 'Handel',
    walletCount,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  const addresses = ((await status()).info?.wallets ?? []).map((w) => w.address);
  const balance = (index: number, value: bigint): void => {
    lamports.set(addresses[index] ?? '', value);
  };
  const save = (settings: Partial<FleetSettingsV1>, trade?: TradeSettingsV1) =>
    h.handle({
      type: 'saveSettings',
      settings: {
        maxSpend: [],
        active: [],
        global: defaultFleetSettings().global,
        ...settings,
        ...(trade ? { trade } : {}),
      },
      apiKeys: { helius: 'heliusTradeKey' },
    });
  /** `[wallet, amount, slippageBps]` of every /order, by wallet. */
  const asked = () =>
    jupiter
      .orderRequests()
      .map((r) => [addresses.indexOf(r.taker ?? ''), r.amount, r.slippageBps] as const)
      .sort((a, b) => a[0] - b[0]);
  const buy = async (): Promise<WalletEvent[]> => {
    await h.handle({ type: 'refreshBalances' });
    await h.handle({ type: 'startBuy', mint: USDC });
    const finished = () => events.some((e) => e.kind === 'run' && e.phase === 'finished');
    for (let i = 0; i < 400 && !finished(); i++) {
      await clock.runUntil();
      if (!finished()) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!finished()) throw new Error('the run did not finish');
    return events
      .filter(
        (e): e is WalletEvent =>
          e.kind === 'wallet' && ['CONFIRMED', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(e.state),
      )
      .sort((a, b) => a.index - b.index);
  };
  return { h, jupiter, status, balance, save, asked, buy };
}

const trade = (
  fleet: Partial<TradeSettingsV1['fleet']>,
  wallets: TradeSettingsV1['wallets'] = [],
): TradeSettingsV1 => ({ fleet: { ...DEFAULT_TRADE_SETTINGS.fleet, ...fleet }, wallets });

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.code : 'other'),
  );
}

describe('buy amount as a percent of the balance (money path)', () => {
  it('plain, capped by the reserve, and below the reserve (no /order at all)', async () => {
    const t = await setup();
    t.balance(0, 2n * SOL);
    t.balance(1, SOL);
    t.balance(2, 10_000_000n); // 0.01 SOL, below the 0.015 SOL reserve
    await t.save(
      {},
      trade({}, [
        { index: 0, buyPercent: 25 },
        { index: 1, buyPercent: 100 },
        { index: 2, buyPercent: 50 },
      ]),
    );
    const finals = await t.buy();
    // 0: 2 000 000 000 × 25 / 100 = 500 000 000
    // 1: 100 % of 1 SOL would leave nothing: 1 000 000 000 − 15 000 000 = 985 000 000
    expect(t.asked()).toEqual([
      [0, 500_000_000n, undefined],
      [1, 985_000_000n, undefined],
    ]);
    // signed for exactly those amounts (DRY-RUN discards them); 2 never asked
    expect(finals.map((e) => [e.index, e.state, e.reason?.code])).toEqual([
      [0, 'SKIPPED', 'DRY_RUN'],
      [1, 'SKIPPED', 'DRY_RUN'],
      [2, 'SKIPPED', 'INSUFFICIENT_SOL'],
    ]);
  });

  it('the balance changes after the setting: the read at the start counts', async () => {
    const t = await setup(1);
    await t.save({}, trade({ buyAmount: { kind: 'percent', percent: 40 } }));
    t.balance(0, 3n * SOL);
    await t.h.handle({ type: 'refreshBalances' });
    t.balance(0, SOL / 2n); // spent elsewhere before the buy
    await t.buy(); // reads again first
    // 500 000 000 × 40 / 100 = 200 000 000 (not 40 % of 3 SOL)
    expect(t.asked()).toEqual([[0, 200_000_000n, undefined]]);
  });

  it('the fleet default reaches wallets without their own amount only', async () => {
    const t = await setup();
    await t.save(
      { maxSpend: [{ index: 0, lamports: 7_000_000n }] },
      trade({ buyAmount: { kind: 'percent', percent: 10 } }, [{ index: 1, buyPercent: 20 }]),
    );
    await t.buy();
    // 0: its own 0.007 SOL; 1: 20 % of 1 SOL; 2: the default 10 % of 1 SOL
    expect(t.asked()).toEqual([
      [0, 7_000_000n, undefined],
      [1, 200_000_000n, undefined],
      [2, 100_000_000n, undefined],
    ]);
  });
});

describe('slippage into /order', () => {
  it('2.5 % is slippageBps=250; a wallet set to Auto asks without it; the sell value is not used', async () => {
    const t = await setup();
    await t.save(
      { maxSpend: [0, 1, 2].map((index) => ({ index, lamports: 1_000_000n })) },
      trade({ buySlippageBps: 250, sellSlippageBps: 4000 }, [
        { index: 1, buySlippageBps: null },
        { index: 2, sellSlippageBps: 50 },
      ]),
    );
    await t.buy();
    expect(t.asked()).toEqual([
      [0, 1_000_000n, 250],
      [1, 1_000_000n, undefined],
      [2, 1_000_000n, 250],
    ]);
    expect(t.jupiter.orderRequests()[1]).not.toHaveProperty('slippageBps');
  });

  it('a file without trade parameters asks exactly as before: no slippageBps', async () => {
    const t = await setup(2);
    await t.save({ maxSpend: [{ index: 0, lamports: 10_000_000n }] });
    await t.buy();
    expect(t.asked()).toEqual([[0, 10_000_000n, undefined]]);
    expect(Object.keys(t.jupiter.orderRequests()[0] ?? {}).sort()).toEqual([
      'amount',
      'outputMint',
      'taker',
    ]);
  });
});

describe('saveSettings with trade parameters', () => {
  it('refuses what the form refuses, even when sent past the form', async () => {
    const t = await setup();
    const bad = [
      trade({ buyPriorityFeeLamports: 100_000_001n }), // above 0.1 SOL
      trade({ sellSlippageBps: 9 }), // below 0.1 %
      trade({}, [{ index: 0, buySlippageBps: 10_001 }]), // above 100 %
      trade({ sellPercent: 0 }),
      trade({}, [{ index: 5, buyPercent: 10 }]), // not in the fleet
    ];
    for (const value of bad) {
      expect(
        await codeOf(t.save({}, value)),
        JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).toBe('INVALID_SETTINGS');
    }
    // a SOL amount and a percent for one wallet
    expect(
      await codeOf(
        t.save(
          { maxSpend: [{ index: 0, lamports: 5n }] },
          trade({}, [{ index: 0, buyPercent: 5 }]),
        ),
      ),
    ).toBe('INVALID_SETTINGS');
    expect((await t.status()).info?.settings.trade).toEqual(DEFAULT_TRADE_SETTINGS);
  });

  it('settings sent without trade parameters keep the saved ones', async () => {
    const t = await setup();
    const saved = trade({ buySlippageBps: 300 }, [{ index: 2, sellPercent: 30 }]);
    await t.save({}, saved);
    await t.save({ maxSpend: [{ index: 1, lamports: 9n }] });
    expect((await t.status()).info?.settings.trade).toEqual(saved);
  });
});
