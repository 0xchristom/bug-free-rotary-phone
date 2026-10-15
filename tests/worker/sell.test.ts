/**
 * startSell in the vault worker (BUNNDLY-60): real vault and signing, fake Jupiter with
 * real transactions, fake chain and clock. The amounts expected here are worked out by
 * hand; the chain is the truth about what was sold.
 */
import { base58 } from '@scure/base';
import type { RpcTransport } from '@solana/kit';
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  DEFAULT_TRADE_SETTINGS,
  defaultFleetSettings,
  type FleetSettingsV1,
} from '../../src/core/index.ts';
import {
  logEntry,
  toCsv,
  toJson,
  type ExecutorEvent,
  type VerifyEvent,
  type WalletEvent,
} from '../../src/executor/index.ts';
import type { BuyStatus, VaultStatus } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';
import { USDC, buildTransaction, orderFor } from '../helpers/tx-fakes.ts';

// The key derivation is not the subject here: the fast stand-in keeps the key bound to
// the password, the salt and the cost (tests/helpers/fast-kdf.ts, BUNNDLY-74).
vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const OTHER_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** RPC mock: every account has 1 SOL (the SOL balances of `refreshBalances`). */
const chain = {
  createTransport: () =>
    ((config: { payload: unknown }) => {
      const payload = config.payload as { id: unknown; params: [string[]] };
      return Promise.resolve({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          context: { slot: 1n },
          value: payload.params[0].map(() => ({
            lamports: 1_000_000_000n,
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

interface Setup {
  readonly dryRun?: boolean;
  readonly script?: FakeJupiterScript;
  readonly settings?: Partial<FleetSettingsV1>;
  readonly walletCount?: number;
  /** No injected readers and no Helius key: the vault has no way to read balances. */
  readonly noRpc?: boolean;
}

async function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const fakeChain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    chain: fakeChain,
    ...o.script,
  });
  const reads: string[][] = [];
  const failing = { tokens: false };
  /** While set, token reads wait for it: the moment between the read and its answer. */
  const held: { tokens: Promise<void> | null } = { tokens: null };
  const h = createVaultHandler({
    chain,
    executor: {
      jupiter,
      clock,
      landing: fakeChain.checker,
      ...(o.noRpc
        ? {}
        : {
            tokens: async (owners) => {
              reads.push([...owners]);
              await held.tokens;
              return failing.tokens
                ? Promise.reject(new Error('https://rpc.example/?api-key=heliusSellKey'))
                : fakeChain.tokensAfterSells(owners);
            },
            sol: fakeChain.solAfterSells,
          }),
    },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: ExecutorEvent[] = [];
  h.onEvent((e) => {
    if (e.kind !== 'watch' && e.kind !== 'balance' && e.kind !== 'backup') events.push(e);
  });
  await h.handle({
    type: 'create',
    fleetName: 'Sprzedaz',
    walletCount: o.walletCount ?? 3,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  await h.handle({
    type: 'saveSettings',
    settings: {
      ...base,
      global: { ...base.global, ...(o.dryRun === false ? { dryRun: false } : {}) },
      ...o.settings,
    },
    ...(o.noRpc ? {} : { apiKeys: { helius: 'heliusSellKey' } }),
  });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  const addresses = ((await status()).info?.wallets ?? []).map((w) => w.address);
  const addressOf = (index: number): string => {
    const a = addresses[index];
    if (a === undefined) throw new Error(`no wallet ${String(index)}`);
    return a;
  };
  /** Sets what a wallet holds of the token (raw units). */
  const hold = (index: number, amount: bigint): void => {
    fakeChain.deposits.set(addressOf(index), amount);
  };
  const sell = (wallets: readonly number[], percent?: number, mint = USDC) =>
    h.handle({
      type: 'startSell',
      mint,
      wallets,
      ...(percent === undefined ? {} : { percent }),
    }) as Promise<BuyStatus>;
  const secrets = (): string[] => {
    const v = h.inspect().unlocked;
    if (!v) return [];
    return [
      new TextDecoder().decode(v.mnemonic),
      ...v.wallets.flatMap((w) => [
        base58.encode(w.secretKey),
        base58.encode(w.secretKey.slice(0, 32)),
      ]),
    ];
  };
  /** `amount` of every `/order` so far, by wallet index. */
  const asked = (): [number, bigint][] =>
    jupiter
      .orderRequests()
      .map((r): [number, bigint] => [addresses.indexOf(r.taker ?? ''), r.amount])
      .sort((a, b) => a[0] - b[0] || Number(a[1] - b[1]));
  return {
    clock,
    jupiter,
    fakeChain,
    h,
    events,
    status,
    addressOf,
    hold,
    sell,
    secrets,
    asked,
    reads,
    failing,
    held,
  };
}

const finals = (events: readonly ExecutorEvent[]): WalletEvent[] =>
  events
    .filter(
      (e): e is WalletEvent =>
        e.kind === 'wallet' &&
        ['CONFIRMED', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(e.state) &&
        e.reason?.code !== 'EXECUTE_NO_ANSWER',
    )
    .sort((a, b) => a.index - b.index);

/** Runs the fake clock until `count` runs have finished (real WebCrypto needs real time). */
async function runToEnd(
  clock: FakeClock,
  events: readonly ExecutorEvent[],
  count = 1,
): Promise<void> {
  const finished = () =>
    events.filter((e) => e.kind === 'run' && e.phase === 'finished').length >= count;
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

describe('money path: amount in /order', () => {
  it('without a percent in the request each wallet sells its own part, with the sell slippage (BUNNDLY-58)', async () => {
    const t = await setup({
      walletCount: 3,
      settings: {
        trade: {
          fleet: { ...DEFAULT_TRADE_SETTINGS.fleet, sellPercent: 50, buySlippageBps: 300 },
          wallets: [
            { index: 0, sellPercent: 25, sellSlippageBps: 1000 },
            { index: 2, sellSlippageBps: null },
          ],
        },
      },
    });
    t.hold(0, 1_000_001n);
    t.hold(1, 999n);
    t.hold(2, 10n);
    await t.sell([0, 1, 2]);
    await runToEnd(t.clock, t.events);
    // By hand: 1 000 001 / 4 = 250 000,25 → 250 000; 999 / 2 = 499,5 → 499; 10 / 2 = 5.
    // The buy slippage (300) never goes into a sell.
    expect(
      t.jupiter
        .orderRequests()
        .map((r) => [t.asked().find(([, a]) => a === r.amount)?.[0], r.amount, r.slippageBps])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [0, 250_000n, 1000],
      [1, 499n, undefined],
      [2, 5n, undefined],
    ]);
  });

  it('25 %, 50 % and 100 % of the balance, 6 and 9 decimals, rounded down', async () => {
    const t = await setup({ walletCount: 2 });
    t.hold(0, 1_234_567_891n); // 1234.567891 of a 6-decimal token
    t.hold(1, 987_654_321_987_654_321n); // 987654321.987654321 of a 9-decimal token
    const perRun: [number, bigint][][] = [];
    for (const [n, percent] of [25, 50, 100].entries()) {
      const before = t.jupiter.orderRequests().length;
      await t.sell([0, 1], percent);
      await runToEnd(t.clock, t.events, n + 1);
      perRun.push(
        t.asked().filter(([, amount]) =>
          t.jupiter
            .orderRequests()
            .slice(before)
            .some((r) => r.amount === amount),
        ),
      );
    }
    // By hand: 1 234 567 891 / 4 = 308 641 972,75; / 2 = 617 283 945,5.
    // 987 654 321 987 654 321 / 4 = 246 913 580 496 913 580,25; / 2 = …160,5.
    expect(perRun).toEqual([
      [
        [0, 308_641_972n],
        [1, 246_913_580_496_913_580n],
      ],
      [
        [0, 617_283_945n],
        [1, 493_827_160_993_827_160n],
      ],
      [
        [0, 1_234_567_891n],
        [1, 987_654_321_987_654_321n],
      ],
    ]);
    // every one of them asked to sell the token for SOL
    expect(
      t.jupiter.orderRequests().every((r) => r.inputMint === USDC && r.outputMint === SOL_MINT),
    ).toBe(true);
    expect(t.jupiter.orderRequests()).toHaveLength(6);
  });

  it('no percent in the request sells everything', async () => {
    const t = await setup({ walletCount: 1 });
    t.hold(0, 777n);
    await t.sell([0]);
    await runToEnd(t.clock, t.events);
    expect(t.asked()).toEqual([[0, 777n]]);
  });

  it('the balance changed since it was last shown: the read at the start counts', async () => {
    const t = await setup({
      walletCount: 1,
      // the first /order times out, so the wallet asks a second time
      script: { order: (c) => (c.nth === 1 ? { fail: 'TIMEOUT' } : 'ok') },
    });
    t.hold(0, 1_000n); // what the table showed
    t.hold(0, 600n); // what the wallet holds when SELL is clicked
    await t.sell([0], 50);
    t.hold(0, 10_000n); // a deposit after the start does not raise the plan
    await runToEnd(t.clock, t.events);
    // 50 % of 600, not of 1 000 and not of 10 000, on the first try and on the retry
    expect(t.asked()).toEqual([
      [0, 300n],
      [0, 300n],
    ]);
    // one fresh read, of the selected wallet only, before the first /order
    expect(t.reads[0]).toEqual([t.addressOf(0)]);
  });
});

describe('startSell', () => {
  it('DRY-RUN by default: listed wallets sign and skip; an empty one costs no request', async () => {
    const t = await setup();
    t.hold(0, 500n);
    t.hold(2, 900n); // wallet 1 holds nothing
    const started = await t.sell([0, 1, 2]);
    expect(started).toMatchObject({
      side: 'sell',
      dryRun: true,
      wallets: 3,
      mint: USDC,
      accepting: true,
    });
    expect(await t.status()).toMatchObject({ armed: true, buy: { side: 'sell' } });
    await runToEnd(t.clock, t.events);
    expect(finals(t.events).map((e) => [e.index, e.state, e.reason?.code])).toEqual([
      [0, 'SKIPPED', 'DRY_RUN'],
      [1, 'SKIPPED', 'NO_TOKENS'],
      [2, 'SKIPPED', 'DRY_RUN'],
    ]);
    expect(t.jupiter.ordersOf(t.addressOf(1))).toBe(0);
    expect(t.jupiter.executions()).toHaveLength(0);
    expect(await t.status()).toMatchObject({ armed: false, buy: null });
  });

  it('sells with wallets that have no max spend and are not active for buying', async () => {
    const base = defaultFleetSettings();
    const t = await setup({
      walletCount: 2,
      settings: { ...base, active: [{ index: 1, active: false }] },
    });
    t.hold(1, 40n);
    await t.sell([1]);
    await runToEnd(t.clock, t.events);
    expect(t.asked()).toEqual([[1, 40n]]);
  });

  it('live: real signatures go to /execute; each wallet sold once, exactly its plan', async () => {
    const t = await setup({ dryRun: false });
    t.hold(0, 1_001n);
    t.hold(1, 2_003n);
    await t.sell([0, 1], 50);
    await runToEnd(t.clock, t.events);
    expect(finals(t.events).map((e) => e.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    const sent = t.jupiter.executions();
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      const tx = getTransactionDecoder().decode(
        getBase64Encoder().encode(call.signedTransaction ?? ''),
      );
      expect((tx.signatures as Record<string, unknown>)[call.taker]).not.toBeNull();
    }
    // floor(1001 / 2) = 500, floor(2003 / 2) = 1001
    expect(t.fakeChain.successfulBuys(t.addressOf(0)).map((l) => l.spent)).toEqual([500n]);
    expect(t.fakeChain.successfulBuys(t.addressOf(1)).map((l) => l.spent)).toEqual([1_001n]);
  });

  it('no answer after a real signed send that landed: the chain check confirms, one sell', async () => {
    const t = await setup({
      dryRun: false,
      script: { execute: () => ({ fail: 'TIMEOUT', lands: { afterMs: 1_000 } }) },
    });
    t.hold(0, 800n);
    t.hold(1, 900n);
    await t.sell([0, 1]);
    await runToEnd(t.clock, t.events);
    expect(finals(t.events).map((e) => e.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(t.jupiter.calls.filter((c) => c.kind === 'order')).toHaveLength(2);
    expect(t.jupiter.executions()).toHaveLength(2);
    expect(t.fakeChain.successfulBuys(t.addressOf(0)).map((l) => l.spent)).toEqual([800n]);
    expect(t.fakeChain.successfulBuys(t.addressOf(1)).map((l) => l.spent)).toEqual([900n]);
  });

  it('after CONFIRMED both balances confirm the sell (verify events, live only)', async () => {
    const t = await setup({ dryRun: false, script: { executeDelayMs: () => 1_000 } });
    t.hold(0, 4_000n);
    t.hold(1, 6_000n);
    await t.sell([0, 1], 25);
    await runToEnd(t.clock, t.events);
    const verify = (): VerifyEvent[] =>
      t.events
        .filter((e): e is VerifyEvent => e.kind === 'verify')
        .sort((a, b) => a.index - b.index);
    for (let i = 0; i < 100 && verify().length < 2; i++) await t.clock.runUntil();
    // the fake Jupiter pays 100 lamports per unit: 1 000 → 100 000, 1 500 → 150 000
    expect(
      verify().map((e) => [e.index, e.side, e.status, e.expected, e.observed, e.solChange]),
    ).toEqual([
      [0, 'sell', 'MATCH', 1_000n, 1_000n, 100_000n],
      [1, 'sell', 'MATCH', 1_500n, 1_500n, 150_000n],
    ]);

    const dry = await setup();
    dry.hold(0, 4_000n);
    await dry.sell([0]);
    await runToEnd(dry.clock, dry.events);
    expect(dry.events.filter((e) => e.kind === 'verify')).toHaveLength(0);
  });

  it('stop: no new /order, sent transactions finish, then a new command may start', async () => {
    const t = await setup({
      dryRun: false,
      script: { orderDelayMs: () => 50, executeDelayMs: () => 5_000 },
    });
    t.hold(0, 10n);
    t.hold(1, 20n);
    await t.sell([0, 1]);
    await t.clock.runUntil(t.clock.now() + 500); // both sent, executing
    const stopped = (await t.h.handle({ type: 'stop' })) as VaultStatus;
    expect(stopped).toMatchObject({ armed: true, buy: { side: 'sell', accepting: false } });
    await runToEnd(t.clock, t.events);
    expect(t.jupiter.calls.filter((c) => c.kind === 'order')).toHaveLength(2);
    expect(finals(t.events).map((e) => e.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await t.status()).toMatchObject({ armed: false, buy: null });
  });

  it('the exported log says "sell" and has no mnemonic, keys, API key or signed transaction', async () => {
    const t = await setup({ dryRun: false });
    t.hold(0, 1_000_000n);
    const held = t.secrets();
    await t.sell([0]);
    await runToEnd(t.clock, t.events);
    const entries = t.events.map((e) =>
      logEntry(e, { addressOf: (i) => t.addressOf(i), decimals: 6 }),
    );
    expect(entries.map((e) => e.side)).toEqual(entries.map(() => 'sell'));
    const confirmed = entries.find((e) => e.state === 'CONFIRMED');
    // 1 token (6 decimals) for 100 000 000 lamports: 0.1 SOL per token
    expect(confirmed).toMatchObject({ spent: 1_000_000n, received: 100_000_000n, price: '0.1' });
    expect(held.length).toBeGreaterThan(3);
    for (const text of [toCsv(entries), toJson(entries)]) {
      expect(text).toContain('CONFIRMED');
      expect(text).toContain('sell');
      for (const secret of held) expect(text).not.toContain(secret);
      expect(text).not.toContain('heliusSellKey');
      for (const call of t.jupiter.executions()) {
        expect(text).not.toContain(call.signedTransaction);
      }
    }
  });
});

describe('startSell refusals', () => {
  it('bad mint, SOL itself, bad percent, bad wallet list: nothing is read or started', async () => {
    const t = await setup();
    t.hold(0, 100n);
    expect(await codeOf(t.sell([0], 100, 'not-a-mint'))).toBe('INVALID_MINT_ADDRESS');
    expect(await codeOf(t.sell([0], 100, SOL_MINT))).toBe('INVALID_MINT_ADDRESS');
    for (const percent of [0, 101, -5, 12.5, '50', null]) {
      expect(
        await codeOf(t.h.handle({ type: 'startSell', mint: USDC, wallets: [0], percent })),
        String(percent),
      ).toBe('INTERNAL_ERROR');
    }
    for (const wallets of [[0, 0], [7], ['0'], [0.5], 'all', undefined]) {
      expect(
        await codeOf(t.h.handle({ type: 'startSell', mint: USDC, wallets })),
        JSON.stringify(wallets),
      ).toBe('INTERNAL_ERROR');
    }
    expect(await codeOf(t.sell([]))).toBe('NO_WALLETS_TO_SELL');
    expect(t.reads).toEqual([]);
    expect(t.jupiter.calls).toHaveLength(0);
    expect((await t.status()).armed).toBe(false);
  });

  it('one command at a time: no second sell and no buy while a sell runs', async () => {
    const t = await setup({ script: { orderDelayMs: () => 600_000 } });
    t.hold(0, 100n);
    await t.sell([0]);
    expect(await codeOf(t.sell([0]))).toBe('BUY_RUNNING');
    expect(await codeOf(t.h.handle({ type: 'startBuy', mint: USDC }))).toBe('BUY_RUNNING');
    expect(await codeOf(t.h.handle({ type: 'lock' }))).toBe('BUY_RUNNING');
    await runToEnd(t.clock, t.events);
    expect(await codeOf(t.h.handle({ type: 'lock' }))).toBe('ok');
  });

  it('auto-lock while the balances are read: no plan, no order, nothing signed', async () => {
    const t = await setup();
    t.hold(0, 100n);
    let answer = (): void => undefined;
    t.held.tokens = new Promise((resolve) => {
      answer = resolve;
    });
    const selling = codeOf(t.sell([0]));
    await vi.waitFor(() => {
      expect(t.reads).toHaveLength(1);
    });
    await t.clock.runUntil(t.clock.now() + 60_000);
    expect(t.h.checkAutoLock()).toBe(true);
    answer();
    expect(await selling).toBe('VAULT_LOCKED');
    await t.clock.runUntil();
    expect(t.jupiter.calls).toHaveLength(0);
    expect(t.events).toEqual([]);
  });

  it('locked vault, no way to read balances, and a failed read', async () => {
    const noRpc = await setup({ noRpc: true });
    expect(await codeOf(noRpc.sell([0]))).toBe('HELIUS_KEY_MISSING');

    const t = await setup();
    t.hold(0, 100n);
    t.failing.tokens = true;
    expect(await codeOf(t.sell([0]))).toBe('RPC_UNAVAILABLE');
    expect((await t.status()).armed).toBe(false);
    expect(t.jupiter.calls).toHaveLength(0);

    await t.h.handle({ type: 'lock' });
    expect(await codeOf(t.sell([0]))).toBe('VAULT_LOCKED');
  });
});

describe('the vault signs a sell only within its own plan', () => {
  const sellOrder = (taker: string, inAmount: bigint, inputMint = USDC) =>
    orderFor(taker, buildTransaction({ feePayer: taker }), {
      inputMint,
      outputMint: SOL_MINT,
      inAmount,
    });

  it('no sell running: a sell order is refused whatever it says', async () => {
    const t = await setup();
    const taker = t.addressOf(0);
    expect(
      await t.h.signOrder(
        0,
        { inputMint: USDC, outputMint: SOL_MINT, amount: 1n },
        sellOrder(taker, 1n),
      ),
    ).toEqual({ ok: false, problem: 'NO_SELL_PLAN' });
  });

  it('while a sell runs: up to the plan yes, above it no, another mint no', async () => {
    const t = await setup({ script: { orderDelayMs: () => 600_000 } });
    t.hold(0, 1_000n);
    await t.sell([0], 50); // the plan of wallet 0 is 500; wallet 1 is not in the run
    const taker = t.addressOf(0);
    const ask = (amount: bigint, mint = USDC, output = SOL_MINT, index = 0) =>
      t.h.signOrder(
        index,
        { inputMint: mint, outputMint: output, amount },
        sellOrder(t.addressOf(index), amount, mint),
      );
    expect(await ask(500n)).toMatchObject({ ok: true });
    expect(await ask(501n)).toEqual({ ok: false, problem: 'OVER_MAX_SPEND' });
    expect(await ask(1_000n)).toEqual({ ok: false, problem: 'OVER_MAX_SPEND' });
    expect(await ask(500n, OTHER_MINT)).toEqual({ ok: false, problem: 'NO_SELL_PLAN' });
    expect(await ask(500n, USDC, OTHER_MINT)).toEqual({ ok: false, problem: 'NO_SELL_PLAN' });
    expect(await ask(1n, USDC, SOL_MINT, 1)).toEqual({ ok: false, problem: 'OVER_MAX_SPEND' });
    // the order answers for another amount than asked, still within the plan
    expect(
      await t.h.signOrder(
        0,
        { inputMint: USDC, outputMint: SOL_MINT, amount: 400n },
        sellOrder(taker, 450n),
      ),
    ).toEqual({ ok: false, problem: 'AMOUNT_MISMATCH' });
    // Jupiter answers with a buy of the token instead of its sale
    expect(
      await t.h.signOrder(
        0,
        { inputMint: USDC, outputMint: SOL_MINT, amount: 500n },
        orderFor(taker, buildTransaction({ feePayer: taker }), { inAmount: 500n }),
      ),
    ).toEqual({ ok: false, problem: 'INPUT_MINT_MISMATCH' });
    await runToEnd(t.clock, t.events);
    // the plan ends with the run
    expect(await ask(500n)).toEqual({ ok: false, problem: 'NO_SELL_PLAN' });
  });
});
