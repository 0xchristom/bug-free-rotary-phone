/**
 * Wallet groups in the vault worker (BUNNDLY-68): each group buys, watches and stops on
 * its own. Fleet of 8: A = {0, 1, 2}, B = {3, …, 7}. Real vault and signing, fake socket,
 * fake Jupiter, RPC mock answering in 1 s. The first wallet of each group is the run's probe
 * (D-035) and gets its answer at once; every other /order is held, so the runs go on.
 */
import { describe, expect, it, vi } from 'vitest';
import { type FleetSettingsV1, type WalletGroupV1 } from '../../src/core/index.ts';
import { USDC, buildTransaction, orderFor } from '../helpers/tx-fakes.ts';
import {
  HELIUS_KEY,
  N,
  CREATOR,
  MINT,
  RPC_DELAY_MS,
  SPREAD_MS,
  A,
  B,
  setup,
  codeOf,
} from './groups-fleet.ts';

// The key derivation is not the subject here: the fast stand-in keeps the key bound to
// the password, the salt and the cost (tests/helpers/fast-kdf.ts, BUNNDLY-74).
vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });

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

  it('a wallet list (BUNNDLY-59): only the listed wallets of the group buy, the saved selection aside', async () => {
    const t = await setup();
    // wallet 1 is unselected in the saved settings, wallet 0 is selected
    await t.saveWith((s) => ({
      ...s,
      active: [
        { index: 0, active: true },
        { index: 1, active: false },
      ],
    }));
    // a wallet of B in A's list: malformed, nothing is asked
    expect(
      await codeOf(t.h.handle({ type: 'startBuy', group: 'g1', mint: USDC, wallets: [2, 3] })),
    ).toBe('INTERNAL_ERROR');
    expect(t.orders).toHaveLength(0);
    // the balances first: a buy without them skips every wallet
    const read = t.h.handle({ type: 'refreshBalances' });
    await t.clock.runUntil(t.clock.now() + RPC_DELAY_MS);
    await read;
    await t.h.handle({ type: 'startBuy', group: 'g1', mint: USDC, wallets: [1, 2] });
    await t.untilIdle();
    expect(t.askedBy(USDC)).toEqual([1, 2]);
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

  it('STOP of B, the second group, stops B only; A keeps taking its Stairs steps (BUNNDLY-61)', async () => {
    const t = await setup(100);
    const stairs = { intervalMs: 60_000, perStep: 1 };
    await t.startBuy('g1', USDC, stairs); // A's steps at a, a + 60 s, a + 120 s
    await t.startBuy('g2', MINT, stairs); // B's steps from about 11 s later
    expect(t.askedBy(USDC)).toEqual([0]);
    expect(t.askedBy(MINT)).toEqual([3]);
    await t.h.handle({ type: 'stop', group: 'g2' });
    // B no longer takes commands (its run may already have ended); A still does
    expect((await t.group('g2'))?.buy?.accepting ?? false).toBe(false);
    expect((await t.group('g1'))?.buy?.accepting).toBe(true);
    await t.clock.runUntil(t.clock.now() + 120_000);
    // A's two later steps came; B's never did
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.askedBy(MINT)).toEqual([3]);
  });

  it('PAUSE of B holds only B’s Stairs steps; A’s steps go on (BUNNDLY-61)', async () => {
    const t = await setup(100);
    const stairs = { intervalMs: 60_000, perStep: 1 };
    await t.startBuy('g1', USDC, stairs); // A's steps at a, a + 60 s, a + 120 s
    await t.startBuy('g2', MINT, stairs); // B's step 1 began about 11 s after A's
    expect(t.askedBy(USDC)).toEqual([0]);
    expect(t.askedBy(MINT)).toEqual([3]);
    await t.h.handle({ type: 'pauseStairs', group: 'g2' });
    expect((await t.group('g2'))?.buy?.paused).toBe(true);
    expect((await t.group('g1'))?.buy?.paused).toBe(false);
    await t.clock.runUntil(t.clock.now() + 120_000);
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.askedBy(MINT)).toEqual([3]);
    await t.h.handle({ type: 'resumeStairs', group: 'g2' });
    expect((await t.group('g2'))?.buy?.paused).toBe(false);
  });

  it('pauseStairs and resumeStairs of A never touch B, whichever group started first', async () => {
    const t = await setup(100);
    const stairs = { intervalMs: 60_000, perStep: 1 };
    await t.startBuy('g1', USDC, stairs);
    await t.startBuy('g2', MINT, stairs);
    const paused = async () => [
      (await t.group('g1'))?.buy?.paused,
      (await t.group('g2'))?.buy?.paused,
    ];
    await t.h.handle({ type: 'pauseStairs', group: 'g1' });
    expect(await paused()).toEqual([true, false]);
    await t.h.handle({ type: 'pauseStairs', group: 'g2' });
    expect(await paused()).toEqual([true, true]);
    await t.h.handle({ type: 'resumeStairs', group: 'g1' });
    expect(await paused()).toEqual([false, true]);
    // B stays held while A's next steps go on
    await t.clock.runUntil(t.clock.now() + 150_000);
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.askedBy(MINT)).toEqual([3]);
    await t.h.handle({ type: 'resumeStairs', group: 'g2' });
    expect(await paused()).toEqual([undefined, false]); // A has finished
  });

  it('B armed: a manual BUY of B is refused (BUY_WHILE_ARMED) with no /order; A buys; B buys after DISARM (BUNNDLY-86)', async () => {
    const t = await setup();
    const socket = await t.arm('g2');
    expect(await codeOf(t.h.handle({ type: 'startBuy', group: 'g2', mint: MINT }))).toBe(
      'BUY_WHILE_ARMED',
    );
    // one wallet of B by its row ▶ is refused the same way
    expect(
      await codeOf(t.h.handle({ type: 'startBuy', group: 'g2', mint: MINT, wallets: [4] })),
    ).toBe('BUY_WHILE_ARMED');
    expect(t.orders).toHaveLength(0);
    expect((await t.group('g2'))?.buy).toBeNull();
    expect((await t.group('g2'))?.watch?.armed).toBe(true);
    expect(socket.closed).toBe(false);

    // A is not armed and buys as before
    await t.startBuy('g1', USDC);
    expect(t.askedBy(USDC)).toEqual([0, 1, 2]);
    expect(t.askedBy(MINT)).toEqual([]);

    // disarmed, B buys by hand again
    await t.h.handle({ type: 'disarm', group: 'g2' });
    await t.startBuy('g2', MINT);
    expect(t.askedBy(MINT)).toEqual([3, 4, 5, 6, 7]);
  });

  it('STOP of an armed B disarms B: a token detected later buys nothing; A stays armed (BUNNDLY-87)', async () => {
    const t = await setup();
    const a = await t.arm('g1');
    const b = await t.arm('g2');
    await t.h.handle({ type: 'stop', group: 'g2' });
    expect((await t.group('g2'))?.watch?.armed).toBe(false);
    expect(b.closed).toBe(true);
    expect((await t.group('g1'))?.watch?.armed).toBe(true);
    expect(a.closed).toBe(false);
    // the creator's token arrives after STOP: nothing is bought
    b.message(N.message);
    await t.clock.runUntil(t.clock.now() + SPREAD_MS);
    expect(t.orders).toHaveLength(0);
    expect((await t.group('g2'))?.buy).toBeNull();
  });

  it('STOP of a B that is armed and buying stops the buy and disarms (BUNNDLY-87)', async () => {
    const t = await setup();
    const socket = await t.arm('g2');
    socket.message(N.message);
    await t.clock.runUntil(t.clock.now() + SPREAD_MS);
    expect(t.askedBy(MINT)).toEqual([3, 4, 5, 6, 7]);
    await t.h.handle({ type: 'stop', group: 'g2' });
    const b = await t.group('g2');
    expect(b?.buy?.accepting ?? false).toBe(false);
    expect(b?.watch?.armed).toBe(false);
    expect(socket.closed).toBe(true);
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

    expect(await codeOf(t.saveWith(global({ explorer: 'orb', autoLockMinutes: 60 })))).toBe('ok');
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
