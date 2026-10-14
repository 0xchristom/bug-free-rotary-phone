/**
 * Selling with the executor (BUNNDLY-60): the same run as a buy with the mints swapped.
 * Fake Jupiter, chain and clock; the chain is the truth about what was sold.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';
import {
  ExecuteLimiter,
  OrderLimiter,
  logEntry,
  startRun,
  type ExecutorEvent,
  type ExecutorWallet,
  type OrderSigner,
  type RunSummary,
  type Side,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { parseExecution, type JupiterClient } from '../../src/jupiter/client.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeJupiter, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Wallets by their planned token amounts; no SOL balance was ever read. */
function holders(amounts: readonly bigint[]): ExecutorWallet[] {
  return amounts.map((maxSpend, i) => ({
    index: i,
    address: `Wallet${String(i).padStart(3, '0')}`,
    maxSpend,
    balance: null,
  }));
}

type SignRequest = Parameters<OrderSigner>[1];

interface Setup {
  readonly walletList: ExecutorWallet[];
  readonly side?: Side;
  readonly plan?: keyof typeof JUPITER_PLAN_RPM;
  readonly script?: FakeJupiterScript;
  readonly dryRun?: boolean;
  readonly wrap?: (jupiter: FakeJupiter) => JupiterClient;
}

function setup(o: Setup) {
  const clock = new FakeClock(true);
  const chain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, { chain, ...o.script });
  const plan = o.plan ?? 'free';
  const events: ExecutorEvent[] = [];
  const signed: SignRequest[] = [];
  const side = o.side ?? 'sell';
  const run = startRun(
    {
      jupiter: o.wrap?.(jupiter) ?? jupiter,
      orderLimiter: new OrderLimiter({ orderRpm: JUPITER_PLAN_RPM[plan], clock }),
      executeLimiter: new ExecuteLimiter({ plan, orderRpm: JUPITER_PLAN_RPM[plan], clock }),
      sign: (_index, request, order) => {
        signed.push(request);
        return Promise.resolve(
          order.transaction === null
            ? { ok: false, problem: 'NO_TRANSACTION' }
            : { ok: true, signedTransaction: `signed-${order.requestId}`, signature: null },
        );
      },
      landing: chain.checker,
      clock,
      emit: (e) => events.push(e),
    },
    {
      runId: 1,
      ...(side === 'sell' ? { side } : {}),
      mint: MINT,
      wallets: o.walletList,
      dryRun: o.dryRun ?? false,
      maxAttempts: 3,
      minReserveLamports: 15_000_000n,
      priceCeilingPercent: 50,
      noRouteWindowMs: 20_000,
      noRouteBackoffMinMs: 500,
      noRouteBackoffMaxMs: 2_000,
    },
  );
  let summary: RunSummary | null = null;
  void run.done.then((s) => {
    summary = s;
  });
  const finish = async (): Promise<RunSummary> => {
    await clock.runUntil();
    if (summary === null) throw new Error('run did not finish');
    return summary;
  };
  return { clock, chain, jupiter, events, signed, run, finish };
}

const walletEvents = (events: ExecutorEvent[]): WalletEvent[] =>
  events.filter((e): e is WalletEvent => e.kind === 'wallet');

const reasons = (s: RunSummary): (string | undefined)[] => s.wallets.map((w) => w.reason?.code);

describe('a sell asks Jupiter for the mint → SOL swap of the planned amount', () => {
  it('/order and the signer get the token as input, SOL as output and exactly the plan', async () => {
    const plan = [308_641_972n, 617_283_945n, 1n];
    const { jupiter, chain, signed, finish } = setup({ walletList: holders(plan) });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(3);
    const byTaker = (a: { taker?: string }, b: { taker?: string }) =>
      (a.taker ?? '').localeCompare(b.taker ?? '');
    expect(jupiter.orderRequests().sort(byTaker)).toEqual([
      { inputMint: MINT, outputMint: SOL_MINT, amount: 308_641_972n, taker: 'Wallet000' },
      { inputMint: MINT, outputMint: SOL_MINT, amount: 617_283_945n, taker: 'Wallet001' },
      { inputMint: MINT, outputMint: SOL_MINT, amount: 1n, taker: 'Wallet002' },
    ]);
    expect([...signed].sort((a, b) => Number(b.amount - a.amount))).toEqual([
      { inputMint: MINT, outputMint: SOL_MINT, amount: 617_283_945n },
      { inputMint: MINT, outputMint: SOL_MINT, amount: 308_641_972n },
      { inputMint: MINT, outputMint: SOL_MINT, amount: 1n },
    ]);
    // the chain: each wallet sold once, exactly its plan
    plan.forEach((amount, i) => {
      const sells = chain.successfulBuys(`Wallet00${String(i)}`);
      expect(sells.map((l) => l.spent)).toEqual([amount]);
    });
  });

  it('a buy still asks without inputMint (the request of a buy did not change)', async () => {
    const { jupiter, signed, finish } = setup({
      side: 'buy',
      walletList: [{ index: 0, address: 'Wallet000', maxSpend: 10_000_000n, balance: 10n ** 9n }],
    });
    await finish();
    expect(jupiter.orderRequests()).toEqual([
      { outputMint: MINT, amount: 10_000_000n, taker: 'Wallet000' },
    ]);
    expect(signed).toEqual([{ outputMint: MINT, amount: 10_000_000n }]);
  });

  it('events of a sell say so; events of a buy have no side field at all', async () => {
    const sell = setup({ walletList: holders([5n]) });
    await sell.finish();
    expect(sell.events.length).toBeGreaterThan(4);
    expect(sell.events.map((e) => e.side)).toEqual(sell.events.map(() => 'sell'));

    const buy = setup({
      side: 'buy',
      walletList: [{ index: 0, address: 'Wallet000', maxSpend: 10_000_000n, balance: 10n ** 9n }],
    });
    await buy.finish();
    expect(buy.events.length).toBeGreaterThan(4);
    expect(buy.events.filter((e) => Object.hasOwn(e, 'side'))).toEqual([]);
  });
});

describe('pre-checks of a sell', () => {
  it('nothing planned: SKIPPED NO_TOKENS without a single request', async () => {
    const { jupiter, finish } = setup({ walletList: holders([0n, 0n]) });
    const s = await finish();
    expect(reasons(s)).toEqual(['NO_TOKENS', 'NO_TOKENS']);
    expect(jupiter.calls).toHaveLength(0);
  });

  it('among holders, only the empty wallet is skipped and it costs no /order', async () => {
    const { jupiter, finish } = setup({ walletList: holders([7n, 0n, 9n]) });
    const s = await finish();
    expect(s.wallets.map((w) => w.state)).toEqual(['CONFIRMED', 'SKIPPED', 'CONFIRMED']);
    expect(jupiter.ordersOf('Wallet001')).toBe(0);
    expect(jupiter.calls.filter((c) => c.kind === 'order')).toHaveLength(2);
  });

  it('no SOL pre-check: a wallet whose SOL was never read still sells', async () => {
    const { finish } = setup({ walletList: holders([7n]) }); // balance: null
    expect((await finish()).counts.CONFIRMED).toBe(1);
  });

  it("no SOL for the fee: Jupiter's answer skips the wallet, nothing is sent", async () => {
    const { jupiter, finish } = setup({
      walletList: holders([7n, 8n]),
      script: {
        order: (c) =>
          c.taker === 'Wallet000' ? { build: 'INSUFFICIENT_SOL_FOR_GAS', errorCode: 2 } : 'ok',
      },
    });
    const s = await finish();
    expect(reasons(s)).toEqual(['INSUFFICIENT_SOL_FOR_GAS', undefined]);
    expect(s.wallets[1]?.state).toBe('CONFIRMED');
    expect(jupiter.ordersOf('Wallet000')).toBe(1);
    expect(jupiter.executions().map((c) => c.taker)).toEqual(['Wallet001']);
  });
});

describe('no price ceiling on a sell', () => {
  // Wallet 0 fills first; everyone after it is quoted a price ten times worse.
  const script: FakeJupiterScript = {
    orderDelayMs: (c) => (c.taker === 'Wallet000' ? 10 : 2_000),
    executeDelayMs: () => 100,
    outAmount: (c) => (c.taker === 'Wallet000' ? c.amount * 100n : c.amount * 10n),
  };
  const three = (side: Side): ExecutorWallet[] =>
    [0, 1, 2].map((i) => ({
      index: i,
      address: `Wallet00${String(i)}`,
      maxSpend: 10_000_000n,
      balance: side === 'buy' ? 10n ** 9n : null,
    }));

  it('the same quotes stop a buy at the ceiling …', async () => {
    const s = await setup({ side: 'buy', walletList: three('buy'), script }).finish();
    expect(reasons(s)).toEqual([undefined, 'PRICE_CEILING', 'PRICE_CEILING']);
  });

  it('… and do not stop a sell', async () => {
    const { jupiter, finish } = setup({ walletList: three('sell'), script });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(3);
    expect(jupiter.executions()).toHaveLength(3);
  });
});

describe('a wallet never sells more than its plan', () => {
  it('no answer after the send, and it landed: sold once, no second /execute', async () => {
    const plan = [1_000n, 2_000n];
    const { jupiter, chain, events, finish } = setup({
      walletList: holders(plan),
      script: { execute: () => ({ fail: 'TIMEOUT', lands: { afterMs: 1_000 } }) },
    });
    const s = await finish();
    expect(s.wallets.map((w) => w.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(jupiter.executions()).toHaveLength(2);
    expect(jupiter.calls.filter((c) => c.kind === 'order')).toHaveLength(2);
    plan.forEach((amount, i) => {
      expect(chain.successfulBuys(`Wallet00${String(i)}`).map((l) => l.spent)).toEqual([amount]);
    });
    // it went through UNKNOWN and the chain check, not straight to a retry
    expect(
      walletEvents(events)
        .filter((e) => e.index === 0)
        .map((e) => e.state),
    ).toEqual(['QUEUED', 'QUOTING', 'SIGNING', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED']);
    expect(chain.checks).toBeGreaterThan(0);
  });

  it('no answer and it did not land: retried only after it expired, sold once', async () => {
    const { jupiter, chain, finish } = setup({
      walletList: holders([1_000n]),
      script: { execute: (c) => (c.nth === 1 ? { fail: 'TIMEOUT' } : 'ok') },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    const [first, second] = jupiter.executions();
    expect(jupiter.executions()).toHaveLength(2);
    // 150 blocks of 400 ms: the second send starts after the first can no longer land
    expect((second?.start ?? 0) - (first?.start ?? 0)).toBeGreaterThanOrEqual(60_000);
    expect(chain.successfulBuys('Wallet000').map((l) => l.spent)).toEqual([1_000n]);
  });

  it('a late landing after a "failed to land" answer is still one sell', async () => {
    const { jupiter, chain, finish } = setup({
      walletList: holders([1_000n]),
      script: { execute: () => ({ code: -1000, lands: { afterMs: 20_000 } }) },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(jupiter.executions()).toHaveLength(1);
    expect(chain.successfulBuys('Wallet000')).toHaveLength(1);
  });
});

describe('STOP and DRY-RUN', () => {
  it('STOP: no new /order; what was sent is followed to the end', async () => {
    // Keyless: 27 orders fit the first minute, 3 wallets wait in the queue.
    const { clock, jupiter, run, finish } = setup({
      walletList: holders(Array.from({ length: 30 }, () => 500n)),
      plan: 'keyless',
      script: { executeDelayMs: () => 5_000 },
    });
    await clock.runUntil(T0 + 2_000);
    run.stop();
    const stoppedAt = clock.now();
    const s = await finish();
    const orders = jupiter.calls.filter((c) => c.kind === 'order');
    expect(orders).toHaveLength(27);
    expect(orders.filter((c) => c.start > stoppedAt)).toEqual([]);
    expect(s.counts.CONFIRMED).toBe(27);
    expect(s.wallets.filter((w) => w.reason?.code === 'STOPPED')).toHaveLength(3);
    expect(jupiter.executions()).toHaveLength(27);
  });

  it('DRY-RUN: real /order for the sell, signed, zero /execute', async () => {
    const { jupiter, chain, signed, finish } = setup({
      walletList: holders([11n, 22n]),
      dryRun: true,
    });
    const s = await finish();
    expect(reasons(s)).toEqual(['DRY_RUN', 'DRY_RUN']);
    expect(jupiter.orderRequests().map((r) => [r.inputMint, r.outputMint])).toEqual([
      [MINT, SOL_MINT],
      [MINT, SOL_MINT],
    ]);
    expect(signed).toHaveLength(2);
    expect(jupiter.executions()).toHaveLength(0);
    expect(chain.landed).toHaveLength(0);
  });
});

describe('amounts of a sell come from totalInputAmount and totalOutputAmount', () => {
  const docs = JSON.parse(readFileSync('tests/fixtures/jupiter-execute.docs.json', 'utf8')) as {
    sellSuccessInputFee: unknown;
  };

  it('a fee taken in the input mint: the result and the log carry what left the wallet', async () => {
    const execution = parseExecution(docs.sellSuccessInputFee);
    if (!execution) throw new Error('fixture');
    // the fixture differs where it matters: 1 000 000 left the wallet, 990 000 was swapped
    expect(execution.inputAmountResult).toBe(990_000n);
    const { events, finish } = setup({
      walletList: holders([1_000_000n]),
      wrap: (jupiter) => ({
        getOrder: (request) => jupiter.getOrder(request),
        execute: async (request) => {
          await jupiter.execute(request);
          return { ok: true, value: execution, rateLimit: null };
        },
      }),
    });
    await finish();
    const confirmed = walletEvents(events).find((e) => e.state === 'CONFIRMED');
    expect(confirmed?.result).toMatchObject({
      totalInputAmount: 1_000_000n,
      totalOutputAmount: 9_240_000n,
    });
    if (!confirmed) throw new Error('not confirmed');
    const entry = logEntry(confirmed, { addressOf: () => null, decimals: 6 });
    // 1 token (6 decimals) sold for 9 240 000 lamports = 0.00924 SOL per token
    expect(entry).toMatchObject({
      side: 'sell',
      spent: 1_000_000n,
      received: 9_240_000n,
      price: '0.00924',
    });
  });
});

describe('slippage per wallet, on either side (BUNNDLY-58)', () => {
  const solWallets = (list: readonly { maxSpend: bigint; slippageBps?: number }[]) =>
    list.map((w, i) => ({
      index: i,
      address: `Wallet${String(i).padStart(3, '0')}`,
      balance: 1_000_000_000n,
      ...w,
    }));

  it('a buy: the wallet with 250 bps asks with slippageBps 250, the Auto one without', async () => {
    const { jupiter, signed, finish } = setup({
      side: 'buy',
      walletList: solWallets([
        { maxSpend: 10_000_000n, slippageBps: 250 },
        { maxSpend: 20_000_000n },
      ]),
    });
    await finish();
    const asked = jupiter.orderRequests().map((r) => [r.taker, r.amount, r.slippageBps]);
    expect(asked).toEqual([
      ['Wallet000', 10_000_000n, 250],
      ['Wallet001', 20_000_000n, undefined],
    ]);
    expect(jupiter.orderRequests()[1]).not.toHaveProperty('slippageBps');
    expect(signed.map((r) => r.amount)).toEqual([10_000_000n, 20_000_000n]);
  });

  it('a sell: the slippage given to the run goes into the sell orders', async () => {
    const { jupiter, finish } = setup({
      walletList: holders([5n, 7n]).map((w, i) => (i === 0 ? { ...w, slippageBps: 1000 } : w)),
    });
    await finish();
    expect(jupiter.orderRequests().map((r) => [r.inputMint, r.amount, r.slippageBps])).toEqual([
      [MINT, 5n, 1000],
      [MINT, 7n, undefined],
    ]);
  });

  it('a buy of 0 lamports (a percent of a balance at the reserve) is skipped without /order', async () => {
    const { jupiter, finish } = setup({
      side: 'buy',
      walletList: solWallets([{ maxSpend: 0n }, { maxSpend: 10_000_000n }]),
    });
    const s = await finish();
    expect(reasons(s)).toEqual(['INSUFFICIENT_SOL', undefined]);
    expect(jupiter.orderRequests().map((r) => r.taker)).toEqual(['Wallet001']);
  });
});
