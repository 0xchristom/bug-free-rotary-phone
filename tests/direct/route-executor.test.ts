/**
 * The executor with the real direct route over a fake devnet RPC (BUNNDLY-48): a lost
 * answer to `sendTransaction` after the RPC took the transaction gives exactly one send
 * and one buy; DRY-RUN simulates and sends nothing.
 */
import { describe, expect, it } from 'vitest';
import { JUPITER_PLAN_RPM } from '../../src/core/settings.ts';
import { deriveWallets } from '../../src/core/index.ts';
import { checkDirectTransaction } from '../../src/direct/check.ts';
import { createDirectRoute } from '../../src/direct/route.ts';
import {
  ExecuteLimiter,
  OrderLimiter,
  startRun,
  type ExecutorEvent,
  type Landing,
  type LandingQuery,
  type OrderSigner,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { signCheckedOrder } from '../../src/worker/sign-order.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { CASE, CASE_LAMPORTS, fakeDirectRpc, type FakeChain } from '../helpers/direct-rpc.ts';

const [derived] = deriveWallets(`${'abandon '.repeat(11)}about`, 0, 1);
if (derived === undefined) throw new Error('fixture');
const wallet = derived;

/** The vault's way: the direct check, then the wallet's key. */
const signer: OrderSigner = async (_index, request, order) => {
  const check = await checkDirectTransaction(order, {
    taker: wallet.address,
    outputMint: request.outputMint,
    amount: request.amount,
    maxSpend: request.amount,
  });
  if (!check.ok) return { ok: false, problem: check.problem };
  return { ok: true, ...(await signCheckedOrder(wallet.secretKey, check.checked)) };
};

async function run(dryRun: boolean, chain: Partial<FakeChain>, landing: Landing) {
  const clock = new FakeClock();
  const fake = fakeDirectRpc(wallet.address, chain);
  const route = createDirectRoute({
    rpc: fake.rpc,
    minReserveLamports: 0n,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
  });
  const queries: LandingQuery[] = [];
  const events: ExecutorEvent[] = [];
  const started = startRun(
    {
      jupiter: route,
      orderLimiter: new OrderLimiter({ orderRpm: JUPITER_PLAN_RPM.free, clock }),
      executeLimiter: new ExecuteLimiter({ plan: 'free', orderRpm: JUPITER_PLAN_RPM.free, clock }),
      sign: signer,
      landing: (q) => {
        queries.push(q);
        return Promise.resolve(landing);
      },
      clock,
      emit: (e) => events.push(e),
    },
    {
      runId: 1,
      mint: CASE.baseMint,
      wallets: [
        { index: 0, address: wallet.address, maxSpend: CASE_LAMPORTS, balance: 1_000_000_000n },
      ],
      dryRun,
      maxAttempts: 3,
      minReserveLamports: 0n,
      priceCeilingPercent: 50,
      noRouteWindowMs: 60_000,
      noRouteBackoffMinMs: 1_000,
      noRouteBackoffMaxMs: 5_000,
    },
  );
  await clock.runUntil();
  const summary = await started.done;
  const states = events.filter((e): e is WalletEvent => e.kind === 'wallet').map((e) => e.state);
  return { fake, summary, queries, states };
}

describe('executor over the direct route', () => {
  it('lost answer after the RPC took it: one send, the chain says landed, one buy', async () => {
    const r = await run(false, { send: 'lost' }, { status: 'landed', signature: 'x', slot: 7n });
    expect(r.fake.count('sendTransaction')).toBe(1);
    expect(r.summary.counts.CONFIRMED).toBe(1);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]?.signature).not.toBeNull();
    expect(r.states).toEqual(['QUEUED', 'QUOTING', 'SIGNING', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED']);
  });

  it('lost answer and the chain says it expired: a new order is sent only then', async () => {
    const r = await run(false, { send: 'lost' }, { status: 'expired' });
    // Each attempt sent once and was checked before the next: 3 attempts, 3 sends.
    expect(r.fake.count('sendTransaction')).toBe(3);
    expect(r.queries).toHaveLength(3);
    expect(r.summary.counts.FAILED).toBe(1);
  });

  it('refused in preflight: nothing was sent, a new attempt goes without a chain check', async () => {
    const r = await run(false, { send: 'preflight' }, { status: 'pending' });
    expect(r.queries).toHaveLength(0);
    expect(r.fake.count('sendTransaction')).toBe(3);
    expect(r.summary.counts.FAILED).toBe(1);
  });

  it('DRY-RUN: simulated once, zero sendTransaction', async () => {
    const r = await run(true, {}, { status: 'pending' });
    expect(r.fake.count('simulateTransaction')).toBe(1);
    expect(r.fake.count('sendTransaction')).toBe(0);
    expect(r.summary.counts.SKIPPED).toBe(1);
    expect(r.summary.wallets[0]?.reason).toMatchObject({ code: 'DRY_RUN' });
  });

  it('DRY-RUN with a failing simulation: the wallet fails, still nothing sent', async () => {
    const r = await run(true, { simulateError: 'InsufficientFundsForRent' }, { status: 'pending' });
    expect(r.fake.count('sendTransaction')).toBe(0);
    expect(r.summary.wallets[0]?.reason).toMatchObject({
      code: 'CHECK_FAILED',
      detail: 'SIMULATION_FAILED:"InsufficientFundsForRent"',
    });
  });
});
