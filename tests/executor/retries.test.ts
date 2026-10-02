/**
 * Retries and idempotency (BUNNDLY-23, D-030): the chain decides before any retry of a
 * wallet whose transaction may have been sent; "no route" window; price ceiling; STOP
 * with transactions in flight. Fake Jupiter, fake chain, fake clock.
 */
import { describe, expect, it } from 'vitest';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';
import {
  EXECUTE_FATAL,
  EXECUTE_NOT_SENT,
  ExecuteLimiter,
  LANDING_TIMEOUT_MS,
  OrderLimiter,
  aboveCeiling,
  startRun,
  type ExecutorEvent,
  type ExecutorWallet,
  type LandingChecker,
  type OrderSigner,
  type RunSummary,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { EXECUTE_CODES } from '../../src/jupiter/client.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';
import { FakeJupiter, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SPEND = 10_000_000n;

function wallets(n: number): ExecutorWallet[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    address: `Wallet${String(i).padStart(3, '0')}`,
    maxSpend: SPEND,
    balance: 1_000_000_000n,
  }));
}

/** Like the vault: the signature is known before sending only when the taker pays. */
const signer: OrderSigner = (_index, _request, order) =>
  Promise.resolve(
    order.transaction === null
      ? { ok: false, problem: 'NO_TRANSACTION' }
      : {
          ok: true,
          signedTransaction: `signed-${order.requestId}`,
          signature: order.signatureFeePayer === order.taker ? `sig-${order.requestId}` : null,
        },
  );

interface Setup {
  readonly n?: number;
  readonly script?: FakeJupiterScript;
  readonly maxAttempts?: number;
  readonly priceCeilingPercent?: number;
  readonly noRouteWindowMs?: number;
  readonly landing?: (chain: FakeChain) => LandingChecker;
}

function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const chain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, { chain, ...o.script });
  const events: ExecutorEvent[] = [];
  const run = startRun(
    {
      jupiter,
      orderLimiter: new OrderLimiter({ orderRpm: JUPITER_PLAN_RPM.free, clock }),
      executeLimiter: new ExecuteLimiter({ plan: 'free', orderRpm: JUPITER_PLAN_RPM.free, clock }),
      sign: signer,
      landing: o.landing?.(chain) ?? chain.checker,
      clock,
      emit: (e) => events.push(e),
    },
    {
      runId: 1,
      mint: MINT,
      wallets: wallets(o.n ?? 1),
      dryRun: false,
      maxAttempts: o.maxAttempts ?? 3,
      minReserveLamports: 15_000_000n,
      priceCeilingPercent: o.priceCeilingPercent ?? 50,
      noRouteWindowMs: o.noRouteWindowMs ?? 20_000,
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
  const states = (index = 0): string[] =>
    events
      .filter((e): e is WalletEvent => e.kind === 'wallet' && e.index === index)
      .map((e) => e.state);
  const last = (index = 0): WalletEvent | undefined =>
    events.filter((e): e is WalletEvent => e.kind === 'wallet' && e.index === index).at(-1);
  return { clock, chain, jupiter, events, run, finish, states, last };
}

const orders = (jupiter: FakeJupiter) => jupiter.calls.filter((c) => c.kind === 'order');

describe('timeout after sending (SPEC 7)', () => {
  it('known signature: it landed after all, so CONFIRMED and no second buy', async () => {
    const { chain, jupiter, finish, states, last } = setup({
      script: { execute: () => ({ fail: 'TIMEOUT', lands: { afterMs: 200 } }) },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(orders(jupiter)).toHaveLength(1);
    expect(chain.successfulBuys('Wallet000')).toHaveLength(1);
    expect(states()).toEqual(['QUEUED', 'QUOTING', 'SIGNING', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED']);
    expect(last()?.result?.signature).toBe(chain.landed[0]?.signature);
  });

  it('unknown signature (RFQ): found through the taker, CONFIRMED, no second buy', async () => {
    const { chain, jupiter, finish } = setup({
      script: {
        rfq: () => true,
        executeDelayMs: () => 10_000,
        execute: () => ({ fail: 'TIMEOUT', lands: { afterMs: 9_000 } }),
      },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(orders(jupiter)).toHaveLength(1);
    expect(chain.successfulBuys('Wallet000')).toHaveLength(1);
  });

  it('it lands only after the answer: the check waits, sees it, no retry', async () => {
    const { chain, jupiter, finish } = setup({
      script: { execute: () => ({ code: -1000, lands: { afterMs: 30_000 } }) },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(orders(jupiter)).toHaveLength(1);
    expect(chain.checks).toBeGreaterThan(10); // every 2 s until it showed up
  });

  it('it never landed: retried only after it could no longer land, then CONFIRMED', async () => {
    let n = 0;
    const { chain, jupiter, finish, states } = setup({
      script: { execute: () => (++n === 1 ? { fail: 'TIMEOUT' } : 'ok') },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    const [first, second] = orders(jupiter);
    // block height + 150 at 400 ms per block: about 60 s after the first /order
    const deadline = chain.deadline({
      lastValidBlockHeight: chain.height(first?.start) + 150n,
      expireAt: null,
    });
    expect(second?.start).toBeGreaterThanOrEqual(deadline);
    expect(chain.successfulBuys('Wallet000')).toHaveLength(1);
    expect(states()).toContain('UNKNOWN');
  });

  it('RFQ that never landed: retried after expireAt and the blockhash life', async () => {
    let n = 0;
    const { jupiter, finish } = setup({
      script: { rfq: () => true, execute: () => (++n === 1 ? { fail: 'NETWORK' } : 'ok') },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    const [first, second] = orders(jupiter);
    expect((second?.start ?? 0) - (first?.start ?? 0)).toBeGreaterThanOrEqual(90_000);
  });

  it('the chain cannot be read: UNKNOWN for good after the limit, never retried', async () => {
    const { jupiter, finish, last } = setup({
      script: { execute: () => ({ fail: 'TIMEOUT' }) },
      landing: () => () => Promise.reject(new Error('RPC_UNAVAILABLE')),
    });
    const s = await finish();
    expect(s.counts.UNKNOWN).toBe(1);
    expect(orders(jupiter)).toHaveLength(1);
    expect(last()?.reason).toEqual({
      kind: 'UNKNOWN',
      code: 'LANDING_UNRESOLVED',
      detail: 'TIMEOUT',
    });
    expect(last()?.times.sinceStartMs).toBeGreaterThanOrEqual(LANDING_TIMEOUT_MS);
  });

  it('landed with an error (slippage): nothing bought, retried, one buy in the end', async () => {
    let n = 0;
    const { chain, finish, last } = setup({
      script: { execute: () => (++n === 1 ? { code: 6001, lands: { ok: false } } : 'ok') },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(chain.landed.map((l) => l.ok)).toEqual([false, true]);
    expect(last()?.attempt).toBe(2);
  });
});

describe('every documented /execute code has a path', () => {
  const codes = Object.keys(EXECUTE_CODES)
    .map(Number)
    .filter((c) => c !== 0);

  it.each(codes)('code %i', async (code) => {
    let n = 0;
    const { chain, jupiter, finish, last } = setup({
      script: { execute: () => (++n === 1 ? { code } : 'ok') },
    });
    const s = await finish();
    if (EXECUTE_FATAL.has(code)) {
      // our mistake: FAILED, no retry, the chain is not asked
      expect(s.counts.FAILED).toBe(1);
      expect(last()?.reason?.code).toBe('EXECUTE_FAILED');
      expect(orders(jupiter)).toHaveLength(1);
      expect(chain.checks).toBe(0);
    } else if (EXECUTE_NOT_SENT.has(code)) {
      // nothing was sent: a new /order right away, without a chain check
      expect(s.counts.CONFIRMED).toBe(1);
      expect(orders(jupiter)).toHaveLength(2);
      expect(chain.checks).toBe(0);
    } else {
      // may be on the chain (failed to land, unknown): checked before the retry
      expect([-1000, -1001, -2000, -2001]).toContain(code);
      expect(s.counts.CONFIRMED).toBe(1);
      expect(orders(jupiter)).toHaveLength(2);
      expect(chain.checks).toBeGreaterThan(0);
    }
    expect(chain.successfulBuys('Wallet000').length).toBeLessThanOrEqual(1);
  });

  it('every non-success code is in exactly one group or checked', () => {
    for (const code of codes) {
      expect(EXECUTE_FATAL.has(code) && EXECUTE_NOT_SENT.has(code)).toBe(false);
    }
  });
});

describe('"no route" (SPEC 7)', () => {
  it('no route for the first 5 s, then success: CONFIRMED without using attempts', async () => {
    const { clock, jupiter, finish, last } = setup({
      maxAttempts: 1,
      script: {
        order: () => (clock.now() < T0 + 5_000 ? { fail: 'NO_ROUTE', httpStatus: 400 } : 'ok'),
      },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    const starts = orders(jupiter).map((c) => c.start - T0);
    // backoff 500 ms → 1 s → 2 s → 2 s … after each 100 ms answer
    expect(starts.slice(0, 4)).toEqual([0, 600, 1_700, 3_800]);
    expect(last()?.attempt).toBe(1);
  });

  it('still no route after the window: FAILED (NO_ROUTE)', async () => {
    const { jupiter, finish, last } = setup({
      noRouteWindowMs: 10_000,
      script: { order: () => ({ fail: 'NO_ROUTE', httpStatus: 400 }) },
    });
    const s = await finish();
    expect(s.counts.FAILED).toBe(1);
    expect(last()?.reason).toEqual({ kind: 'FAILED', code: 'NO_ROUTE', detail: 'NO_ROUTE' });
    const starts = orders(jupiter).map((c) => c.start - T0);
    expect(Math.max(...starts)).toBeLessThan(10_000 + 2_100);
  });

  it('STOP during the backoff: SKIPPED (STOPPED) at once, no later /order', async () => {
    const { clock, jupiter, run, finish, last } = setup({
      script: { order: () => ({ fail: 'NO_ROUTE', httpStatus: 400 }) },
    });
    await clock.runUntil(T0 + 300); // first answer at 100 ms, waiting 500 ms
    run.stop();
    const stopAt = clock.now();
    await finish();
    expect(last()?.reason?.code).toBe('STOPPED');
    expect(orders(jupiter).filter((c) => c.start > stopAt)).toHaveLength(0);
  });
});

describe('price ceiling (SPEC 7)', () => {
  it('after the first fill, a quote above the ceiling is SKIPPED; one below goes ahead', async () => {
    // wallet 0 fills first at 100 tokens per lamport-unit; then 1 quotes +60 %, 2 quotes +40 %
    const { finish, last } = setup({
      n: 3,
      priceCeilingPercent: 50,
      script: {
        orderDelayMs: (c) => (c.taker === 'Wallet000' ? 100 : 2_000),
        outAmount: (c) =>
          c.taker === 'Wallet001'
            ? (c.amount * 100n * 10n) / 16n
            : c.taker === 'Wallet002'
              ? (c.amount * 100n * 10n) / 14n
              : c.amount * 100n,
      },
    });
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(2);
    expect(last(1)?.reason?.code).toBe('PRICE_CEILING');
    expect(last(1)?.quote?.outAmount).toBe(625_000_000n);
    expect(last(2)?.state).toBe('CONFIRMED');
  });

  it('cross-multiplied on bigint: exactly at the ceiling passes, one unit worse does not', () => {
    const entry = { input: 10_000_000n, output: 1_000_000_000n };
    // +50 %: 10_000_000 lamports for 666_666_666.67 tokens
    expect(aboveCeiling(entry, { inAmount: 15_000_000n, outAmount: 1_000_000_000n }, 50)).toBe(
      false,
    );
    expect(aboveCeiling(entry, { inAmount: 15_000_001n, outAmount: 1_000_000_000n }, 50)).toBe(
      true,
    );
    expect(aboveCeiling(entry, { inAmount: 1n, outAmount: 0n }, 50)).toBe(true);
    // huge values do not lose precision
    const big = { input: 2n ** 63n, output: 3n ** 39n };
    expect(aboveCeiling(big, { inAmount: 2n ** 63n, outAmount: 3n ** 39n }, 1)).toBe(false);
  });

  it('no fill yet: no ceiling', async () => {
    const { finish } = setup({ n: 2, script: { outAmount: () => 1n } });
    const s = await finish();
    // both quoted before any fill, both buy
    expect(s.counts.CONFIRMED).toBe(2);
  });
});

describe('STOP with transactions in flight (SPEC 7)', () => {
  it('a wallet being checked is followed to the end: landed → CONFIRMED', async () => {
    const { clock, chain, run, finish } = setup({
      script: { execute: () => ({ fail: 'TIMEOUT', lands: { afterMs: 20_000 } }) },
    });
    await clock.runUntil(T0 + 5_000); // UNKNOWN, checking
    run.stop();
    const s = await finish();
    expect(s.counts.CONFIRMED).toBe(1);
    expect(chain.successfulBuys('Wallet000')).toHaveLength(1);
  });

  it('… did not land → SKIPPED (STOPPED), no new /order', async () => {
    const { clock, jupiter, run, finish, last } = setup({
      script: { execute: () => ({ fail: 'TIMEOUT' }) },
    });
    await clock.runUntil(T0 + 5_000);
    run.stop();
    const s = await finish();
    expect(s.counts.SKIPPED).toBe(1);
    expect(last()?.reason?.code).toBe('STOPPED');
    expect(orders(jupiter)).toHaveLength(1);
  });
});

describe('attempts (SPEC 7)', () => {
  it('slippage every time: FAILED (MAX_ATTEMPTS) after maxAttempts, never a second buy', async () => {
    const { chain, jupiter, finish, last } = setup({
      maxAttempts: 3,
      script: { execute: () => ({ code: 6001, lands: { ok: false } }) },
    });
    const s = await finish();
    expect(s.counts.FAILED).toBe(1);
    expect(last()?.reason?.code).toBe('MAX_ATTEMPTS');
    expect(orders(jupiter)).toHaveLength(3);
    expect(chain.successfulBuys('Wallet000')).toHaveLength(0);
  });
});
