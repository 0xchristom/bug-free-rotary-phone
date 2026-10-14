/**
 * Wallet groups in the vault worker (BUNNDLY-68): each group buys, watches and stops on
 * its own. Fleet of 8: A = {0, 1, 2}, B = {3, …, 7}. Real vault and signing, fake socket,
 * fake Jupiter, RPC mock answering in 1 s. The first wallet of each group is the run's probe
 * (D-035) and gets its answer at once; every other /order is held, so the runs go on.
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  defaultFleetSettings,
  type FleetSettingsV1,
  type WalletGroupV1,
} from '../../src/core/index.ts';
import type { JupiterClient } from '../../src/jupiter/index.ts';
import type { VaultFileResult, VaultStatus, WorkerEvent } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';
import { launch, signatureOf } from '../helpers/launch-fixtures.ts';
import { USDC, buildTransaction, orderFor } from '../helpers/tx-fakes.ts';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const HELIUS_KEY = 'heliusGroupsKey';
const N = launch(0);
const CREATOR = N.watched;
const MINT = N.expectedMint; // what B's watcher detects
const RPC_DELAY_MS = 1_000;
/** Every /order but the probe waits this long: the runs stay running for the test. */
const HOLD_MS = 600_000;
/** Enough for the shared order limiter (60 a minute by default) to let 8 orders out. */
const SPREAD_MS = 10_000;

const A: WalletGroupV1 = { id: 'g1', name: 'Snipers', wallets: [0, 1, 2] };
const B: WalletGroupV1 = { id: 'g2', name: 'Rest', wallets: [3, 4, 5, 6, 7] };

function bigints(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(bigints);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigints(v)]));
  }
  return value;
}

async function setup(
  holdMs = HOLD_MS,
  fleet: { readonly count: number; readonly groups: readonly WalletGroupV1[] } = {
    count: 8,
    groups: [A, B],
  },
) {
  const clock = new FakeClock();
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'getMultipleAccounts':
        return {
          context: { slot: 1 },
          value: (params[0] as string[]).map(() => ({
            lamports: 1_000_000_000,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
            rentEpoch: 0,
            space: 0,
          })),
        };
      case 'getSignaturesForAddress':
        return [];
      case 'getTransaction':
        return params[0] === signatureOf(N) ? N.tx : null;
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const transport = (async (config: { payload: unknown }) => {
    const payload = config.payload as { id: unknown; method: string; params: unknown[] };
    await clock.sleep(RPC_DELAY_MS);
    return {
      jsonrpc: '2.0',
      id: payload.id,
      result: bigints(answer(payload.method, payload.params)),
    };
  }) as unknown as RpcTransport;
  const sockets: FakeSocket[] = [];
  /** Addresses of wallets 0 and 3, the first of A and of B: the probes. */
  const probes = new Set<string>();
  const fake = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    orderDelayMs: ({ taker }) => (probes.has(taker) ? 100 : holdMs),
  });
  /** Every /order as it is called: the mint, the taker and the lamports asked. */
  const orders: { mint: string; taker: string; amount: bigint }[] = [];
  const jupiter: JupiterClient = {
    getOrder: (request) => {
      orders.push({ mint: request.outputMint, taker: request.taker ?? '', amount: request.amount });
      return fake.getOrder(request);
    },
    execute: (request) => fake.execute(request),
  };
  const h = createVaultHandler({
    chain: { createTransport: () => transport, sleep: () => Promise.resolve() },
    net: {
      createWebSocket: () => {
        const s = new FakeSocket(clock.now());
        sockets.push(s);
        return s;
      },
    },
    executor: { jupiter, clock },
    watch: { perfNow: () => clock.now() },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: WorkerEvent[] = [];
  h.onEvent((e) => events.push(e));
  await h.handle({
    type: 'create',
    fleetName: 'Grupy',
    walletCount: fleet.count,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  const settings = (groups: readonly WalletGroupV1[]): FleetSettingsV1 => ({
    ...base,
    maxSpend: Array.from({ length: fleet.count }, (_, index) => ({
      index,
      lamports: 10_000_000n,
    })),
    global: { ...base.global, mode: 'continuous' },
    groups,
  });
  const save = (groups: readonly WalletGroupV1[]) =>
    h.handle({
      type: 'saveSettings',
      settings: settings(groups),
      apiKeys: { helius: HELIUS_KEY },
    }) as Promise<VaultFileResult>;
  const saved = await save(fleet.groups);
  /** Saves the settings from the start with `change` applied, the groups as they are now. */
  const saveWith = (
    change: (s: FleetSettingsV1) => FleetSettingsV1,
    apiKeys: Record<string, string | null> = {},
  ) => h.handle({ type: 'saveSettings', settings: change(settings(fleet.groups)), apiKeys });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  const addresses = ((await status()).info?.wallets ?? []).map((w) => w.address);
  for (const i of [0, 3]) probes.add(addresses[i] ?? '');
  /** Wallet indices that asked /order for `mint`, ascending. */
  const askedBy = (mint: string): number[] =>
    orders
      .filter((o) => o.mint === mint)
      .map((o) => addresses.indexOf(o.taker))
      .sort((a, b) => a - b);
  const group = async (id: string) => (await status()).groups.find((g) => g.id === id);
  /** The balance read takes the RPC's 1 s of fake time. */
  const withRpc = async <T>(p: Promise<T>): Promise<T> => {
    await clock.runUntil(clock.now() + RPC_DELAY_MS);
    const result = await p;
    await clock.settle();
    return result;
  };
  const startBuy = async (id: string, mint = USDC) => {
    await withRpc(h.handle({ type: 'refreshBalances' }));
    await h.handle({ type: 'startBuy', group: id, mint });
    await clock.runUntil(clock.now() + SPREAD_MS);
  };
  const arm = async (id: string) => {
    await withRpc(h.handle({ type: 'arm', group: id, creator: CREATOR }));
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket');
    socket.connect();
    await clock.settle();
    return socket;
  };
  /** Lets every held /order answer and every run end. */
  const untilIdle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await clock.runUntil(clock.now() + holdMs);
      if ((await status()).groups.every((g) => g.buy === null)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('a run did not finish');
  };
  return {
    clock,
    h,
    addresses,
    events,
    orders,
    status,
    group,
    save,
    saveWith,
    saved,
    askedBy,
    startBuy,
    arm,
    untilIdle,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.code : 'other'),
  );
}

describe('a buy in one group', () => {
  it('startBuy for A: /order only for wallets 0-2, none for 3-7; B stays idle', async () => {
    const t = await setup();
    await t.startBuy('g1');
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.orders).toHaveLength(3);
    const s = await t.status();
    expect(s.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(s.groups[0]).toMatchObject({ id: 'g1', armed: true, buy: { mint: USDC, wallets: 3 } });
    expect(s.groups[1]).toEqual({ id: 'g2', armed: false, buy: null, watch: null });
    // the fields from before groups show the running buy
    expect(s.buy).toEqual(s.groups[0]?.buy);
    expect(s.armed).toBe(true);
  });

  it('a second buy in the same group is refused; the other group starts its own', async () => {
    const t = await setup();
    await t.startBuy('g1');
    expect(await codeOf(t.h.handle({ type: 'startBuy', group: 'g1', mint: MINT }))).toBe(
      'BUY_RUNNING',
    );
    await t.startBuy('g2', MINT);
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.askedBy(MINT)).toEqual([3, 4, 5, 6, 7]);
    const [a, b] = (await t.status()).groups;
    expect(a?.buy?.runId).not.toBe(b?.buy?.runId);
  });

  it('with several groups the request must name one; an unknown group is refused', async () => {
    const t = await setup();
    expect(await codeOf(t.h.handle({ type: 'startBuy', mint: USDC }))).toBe('INTERNAL_ERROR');
    expect(await codeOf(t.h.handle({ type: 'startBuy', group: 'g9', mint: USDC }))).toBe(
      'INTERNAL_ERROR',
    );
    expect(await codeOf(t.h.handle({ type: 'arm', creator: CREATOR }))).toBe('INTERNAL_ERROR');
    expect(t.orders).toEqual([]);
  });

  it('a sell lists only wallets of its own group', async () => {
    const t = await setup();
    // Refused before any balance read; a read would take the RPC's 1 s and then fail.
    const sell = codeOf(
      t.h.handle({ type: 'startSell', group: 'g1', mint: USDC, wallets: [2, 3] }),
    );
    await t.clock.runUntil(t.clock.now() + RPC_DELAY_MS);
    expect(await sell).toBe('INTERNAL_ERROR');
    expect(t.orders).toEqual([]);
  });
});

describe('a wallet signs within the plan of its own group (money path)', () => {
  it("A buys USDC with 0.01 SOL, B buys MINT with 0.02 SOL at once: B signs up to B's amount, never A's", async () => {
    const t = await setup();
    // B's wallets get 20 000 000 lamports, A's keep 10 000 000 (worked out by hand: 0.02
    // and 0.01 SOL), so the two plans differ for every wallet.
    const B_SPEND = 20_000_000n;
    const A_SPEND = 10_000_000n;
    await t.saveWith((s) => ({
      ...s,
      maxSpend: s.maxSpend.map((m) => (m.index >= 3 ? { index: m.index, lamports: B_SPEND } : m)),
    }));
    await t.startBuy('g1', USDC);
    await t.startBuy('g2', MINT);

    const buyOrder = (index: number, mint: string, amount: bigint) =>
      t.h.signOrder(
        index,
        { outputMint: mint, amount },
        orderFor(
          t.addresses[index] ?? '',
          buildTransaction({ feePayer: t.addresses[index] ?? '' }),
          {
            outputMint: mint,
            inAmount: amount,
          },
        ),
      );
    // B's wallet: its own plan, up to the lamport
    expect(await buyOrder(4, MINT, B_SPEND)).toMatchObject({ ok: true });
    expect(await buyOrder(4, MINT, B_SPEND + 1n)).toEqual({ ok: false, problem: 'OVER_MAX_SPEND' });
    // A's wallet: A's plan, not B's larger one
    expect(await buyOrder(1, USDC, A_SPEND)).toMatchObject({ ok: true });
    expect(await buyOrder(1, USDC, A_SPEND + 1n)).toEqual({ ok: false, problem: 'OVER_MAX_SPEND' });

    await t.untilIdle();
    // every /order of B asked B's amount for MINT, every one of A A's amount for USDC
    const asked = (mint: string) =>
      t.orders
        .filter((o) => o.mint === mint)
        .map((o) => [t.addresses.indexOf(o.taker), o.amount])
        .sort(([a], [b]) => Number(a) - Number(b));
    expect(asked(MINT)).toEqual([3, 4, 5, 6, 7].map((i) => [i, B_SPEND]));
    expect(asked(USDC)).toEqual([0, 1, 2].map((i) => [i, A_SPEND]));
    // and every wallet of both groups was signed and went to the end of its DRY-RUN
    const finals = t.events
      .filter((e) => e.kind === 'wallet' && e.state === 'SKIPPED')
      .map((e) => (e.kind === 'wallet' ? [e.index, e.reason?.code] : []))
      .sort(([a], [b]) => Number(a) - Number(b));
    expect(finals).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i, 'DRY_RUN']));
  });
});

describe('two groups at once', () => {
  it('A buys, B armed: a token detected by B is bought by B only; STOP A leaves B as it was', async () => {
    const t = await setup();
    await t.startBuy('g1');
    const socket = await t.arm('g2');
    socket.message(N.message);
    await t.clock.runUntil(t.clock.now() + SPREAD_MS);
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.askedBy(MINT)).toEqual([3, 4, 5, 6, 7]);

    const before = await t.group('g2');
    expect(before).toMatchObject({ armed: true, buy: { mint: MINT, accepting: true } });
    expect(before?.watch?.armed).toBe(true);
    const asked = t.orders.length;

    await t.h.handle({ type: 'stop', group: 'g1' });
    expect((await t.group('g1'))?.buy?.accepting).toBe(false);
    expect(await t.group('g2')).toEqual(before);
    expect(t.orders).toHaveLength(asked);
    expect(socket.closed).toBe(false);
  });

  it('DISARM of one group leaves the watcher of the other armed', async () => {
    const t = await setup();
    const a = await t.arm('g1');
    const b = await t.arm('g2');
    await t.h.handle({ type: 'disarm', group: 'g1' });
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect((await t.group('g1'))?.watch?.armed).toBe(false);
    expect((await t.group('g2'))?.watch?.armed).toBe(true);
    // arming a group twice is refused, as before groups
    expect(await codeOf(t.h.handle({ type: 'arm', group: 'g2', creator: CREATOR }))).toBe(
      'WATCH_ARMED',
    );
  });
});

describe('one request limit for every group (SPEC 2.2)', () => {
  it('two groups of 15 at once, Keyless: 27 /order in the first minute, the other 3 after it', async () => {
    // 30 a minute without a Jupiter key, 90 % of it: 27 (worked out by hand)
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => from + i);
    const t = await setup(100, {
      count: 30,
      groups: [
        { id: 'g1', name: 'First', wallets: range(0, 15) },
        { id: 'g2', name: 'Second', wallets: range(15, 30) },
      ],
    });
    const started = t.clock.now();
    await t.startBuy('g1');
    await t.h.handle({ type: 'startBuy', group: 'g2', mint: MINT });
    await t.clock.runUntil(started + 55_000);
    expect(t.orders).toHaveLength(27);
    expect(t.askedBy(USDC).length).toBeGreaterThan(0);
    expect(t.askedBy(MINT).length).toBeGreaterThan(0);
    await t.untilIdle();
    expect(t.askedBy(USDC)).toEqual(range(0, 15));
    expect(t.askedBy(MINT)).toEqual(range(15, 30));
  });
});

describe('members of a busy group stay', () => {
  it('a move into or out of a buying group is refused; other groups and names may change', async () => {
    const t = await setup();
    await t.startBuy('g1');
    const out = { ...A, wallets: [0, 1] };
    const into = { ...B, wallets: [2, 3, 4, 5, 6, 7] };
    expect(await codeOf(t.save([out, into]))).toBe('GROUP_RUNNING');
    expect(await codeOf(t.save([B, { ...A, id: 'g3' }]))).toBe('GROUP_RUNNING'); // A deleted
    // B gives wallet 7 to a new group C; A gets a new name
    const c: WalletGroupV1 = { id: 'g3', name: 'C', wallets: [7] };
    const next = [{ ...A, name: 'Fast' }, { ...B, wallets: [3, 4, 5, 6] }, c];
    expect(await codeOf(t.save(next))).toBe('ok');
    expect((await t.status()).info?.settings.groups).toEqual(next);
    // a wallet in two groups never passes
    expect(await codeOf(t.save([A, { ...B, wallets: [2, 3, 4, 5, 6, 7] }]))).toBe(
      'INVALID_SETTINGS',
    );
  });

  it('new wallets join the first group: refused while it buys, accepted after', async () => {
    const t = await setup();
    await t.startBuy('g1');
    expect(await codeOf(t.h.handle({ type: 'addWallets', count: 1 }))).toBe('GROUP_RUNNING');
    await t.h.handle({ type: 'stop', group: 'g1' });
    await t.untilIdle();
    expect(await codeOf(t.h.handle({ type: 'addWallets', count: 1 }))).toBe('ok');
    expect((await t.status()).info?.settings.groups).toEqual([{ ...A, wallets: [0, 1, 2, 8] }, B]);
  });
});

describe('an armed group freezes only what its buy depends on (D-039 relaxed)', () => {
  const spend = (index: number, lamports: bigint) => (s: FleetSettingsV1) => ({
    ...s,
    maxSpend: s.maxSpend.map((m) => (m.index === index ? { index, lamports } : m)),
  });
  const inactive = (index: number) => (s: FleetSettingsV1) => ({
    ...s,
    active: [{ index, active: false }],
  });
  const walletSlippage = (index: number) => (s: FleetSettingsV1) => ({
    ...s,
    trade: { ...s.trade, wallets: [{ index, buySlippageBps: 300 }] },
  });
  const global = (patch: Partial<FleetSettingsV1['global']>) => (s: FleetSettingsV1) => ({
    ...s,
    global: { ...s.global, ...patch },
  });

  it("B armed: B's wallets are refused (WALLET_IN_RUN), A's wallets may change", async () => {
    const t = await setup();
    await t.arm('g2');
    for (const change of [spend(4, 20_000_000n), inactive(4), walletSlippage(7)]) {
      expect(await codeOf(t.saveWith(change))).toBe('WALLET_IN_RUN');
    }
    // a fleet default B's wallets take is theirs too
    const fleetSlippage = (s: FleetSettingsV1) => ({
      ...s,
      trade: { ...s.trade, fleet: { ...s.trade.fleet, buySlippageBps: 300 } },
    });
    expect(await codeOf(t.saveWith(fleetSlippage))).toBe('WALLET_IN_RUN');
    expect((await t.status()).info?.settings.maxSpend[4]?.lamports).toBe(10_000_000n);

    for (const change of [spend(1, 20_000_000n), inactive(2), walletSlippage(0)]) {
      expect(await codeOf(t.saveWith(change))).toBe('ok');
    }
    expect((await t.status()).info?.settings.trade.wallets).toEqual([
      { index: 0, buySlippageBps: 300 },
    ]);
    expect((await t.group('g2'))?.watch?.armed).toBe(true);
  });

  it('B armed: the global settings and keys of the run are refused (WATCH_ARMED), the explorer and auto-lock are not', async () => {
    const t = await setup();
    await t.arm('g2');
    for (const change of [
      global({ dryRun: false }),
      global({ minReserveLamports: 20_000_000n }),
      global({ maxAttempts: 2 }),
      global({ mode: 'one-shot' }),
    ]) {
      expect(await codeOf(t.saveWith(change))).toBe('WATCH_ARMED');
    }
    expect(await codeOf(t.saveWith((s) => s, { jupiter: 'jupiterGroupsKey' }))).toBe('WATCH_ARMED');
    expect(await codeOf(t.saveWith((s) => s, { helius: null }))).toBe('WATCH_ARMED');
    expect(await codeOf(t.h.handle({ type: 'setNetwork', network: 'devnet' }))).toBe('WATCH_ARMED');
    expect((await t.status()).info?.settings.global.dryRun).toBe(true);

    expect(await codeOf(t.saveWith(global({ explorer: 'orb', autoLockMinutes: 30 })))).toBe('ok');
    // the same key again is no change
    expect(await codeOf(t.saveWith((s) => s, { helius: HELIUS_KEY }))).toBe('ok');

    await t.h.handle({ type: 'disarm', group: 'g2' });
    expect(await codeOf(t.saveWith(global({ dryRun: false })))).toBe('ok');
    expect(await codeOf(t.saveWith(spend(4, 20_000_000n)))).toBe('ok');
  });

  it('new wallets join the first group: accepted while another group is armed, refused while it is', async () => {
    const t = await setup();
    await t.arm('g2');
    expect(await codeOf(t.h.handle({ type: 'addWallets', count: 1 }))).toBe('ok');
    expect((await t.status()).info?.settings.groups).toEqual([{ ...A, wallets: [0, 1, 2, 8] }, B]);
    await t.arm('g1');
    expect(await codeOf(t.h.handle({ type: 'addWallets', count: 1 }))).toBe('GROUP_RUNNING');
  });
});

describe('auto-lock with groups', () => {
  it('no auto-lock while any group buys or watches; after all of them end it locks', async () => {
    const t = await setup();
    await t.startBuy('g1');
    await t.arm('g2');
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(false);
    await t.h.handle({ type: 'stop', group: 'g1' });
    await t.untilIdle();
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(false); // B still watches
    await t.h.handle({ type: 'disarm', group: 'g2' });
    expect(t.h.checkAutoLock()).toBe(false); // the disarm was activity
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(true);
    expect((await t.status()).groups).toEqual([]);
  });
});

describe('group data stays in the encrypted file', () => {
  it('names and members never reach the public part of the file or the events', async () => {
    const t = await setup();
    expect(t.saved.fileText).not.toContain('Snipers');
    expect(t.saved.fileText).not.toContain('"groups"');
    await t.startBuy('g1');
    const events = JSON.stringify(t.events, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(events).not.toContain('Snipers');
    expect(events).not.toContain('"group');
  });
});
