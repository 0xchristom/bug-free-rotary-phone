/** Confirmation of a buy by the token balance (BUNNDLY-25, D-031). Fake reader and clock. */
import { describe, expect, it } from 'vitest';
import {
  VERIFY_INTERVAL_MS,
  VERIFY_READS,
  createVerifier,
  type TokenReader,
  type VerifyEvent,
} from '../../src/executor/index.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';

const W = [
  { index: 0, address: 'Alice' },
  { index: 1, address: 'Bob' },
];

/** Balances that change at given times; every read is recorded. */
function chainReader(clock: FakeClock, opts: { slot?: bigint; fail?: () => boolean } = {}) {
  const balances = new Map<string, bigint>([
    ['Alice', 100n],
    ['Bob', 0n],
  ]);
  const changes: { at: number; owner: string; add: bigint }[] = [];
  const reads: string[][] = [];
  const read: TokenReader = (owners) => {
    reads.push([...owners]);
    if (opts.fail?.()) return Promise.reject(new Error('RPC_UNAVAILABLE'));
    const amounts = owners.map(
      (o) =>
        (balances.get(o) ?? 0n) +
        changes.filter((c) => c.owner === o && c.at <= clock.now()).reduce((s, c) => s + c.add, 0n),
    );
    return Promise.resolve({ amounts, slot: opts.slot ?? 1_000n });
  };
  const credit = (owner: string, add: bigint, at = clock.now()): void => {
    changes.push({ at, owner, add });
  };
  return { read, reads, credit };
}

function setup(reader: ReturnType<typeof chainReader>, clock: FakeClock) {
  const events: VerifyEvent[] = [];
  const verifier = createVerifier(
    { read: reader.read, clock, emit: (e) => events.push(e) },
    { runId: 7, wallets: W },
  );
  const settle = async () => {
    await clock.runUntil();
    await verifier.idle();
  };
  return { events, verifier, settle };
}

describe('verifier', () => {
  it('reads the baseline of the whole fleet once, at the start', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock);
    setup(reader, clock);
    await clock.settle();
    expect(reader.reads).toEqual([['Alice', 'Bob']]);
  });

  it('MATCH: grew by exactly totalOutputAmount, with full bigint precision', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock);
    const { events, verifier, settle } = setup(reader, clock);
    const big = 2n ** 64n - 101n; // u64 max minus the baseline
    reader.credit('Alice', big);
    verifier.confirmed(0, 2_000n, big);
    await settle();
    expect(events).toEqual([
      { kind: 'verify', runId: 7, at: T0, index: 0, status: 'MATCH', expected: big, observed: big },
    ]);
  });

  it('re-reads every 2 s until the growth shows up', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock);
    const { events, verifier, settle } = setup(reader, clock);
    reader.credit('Bob', 2_101n, T0 + 3_000);
    verifier.confirmed(1, 2_000n, 2_101n);
    await settle();
    expect(events[0]).toMatchObject({ status: 'MATCH', at: T0 + 2 * VERIFY_INTERVAL_MS });
    expect(reader.reads.filter((r) => r[0] === 'Bob' && r.length === 1)).toHaveLength(3);
  });

  it('MISMATCH: grew by another amount (a deposit from someone else)', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock);
    const { events, verifier, settle } = setup(reader, clock);
    reader.credit('Bob', 2_101n + 5n);
    verifier.confirmed(1, 2_000n, 2_101n);
    await settle();
    expect(events[0]).toMatchObject({ status: 'MISMATCH', expected: 2_101n, observed: 2_106n });
    // it kept reading in case the numbers settled, then gave up
    expect(reader.reads.filter((r) => r.length === 1)).toHaveLength(VERIFY_READS);
  });

  it('NO_INCREASE after every re-read', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock);
    const { events, verifier, settle } = setup(reader, clock);
    verifier.confirmed(0, 2_000n, 2_101n);
    await settle();
    expect(events[0]).toMatchObject({ status: 'NO_INCREASE', observed: 0n });
    expect(events[0]?.at).toBe(T0 + (VERIFY_READS - 1) * VERIFY_INTERVAL_MS);
  });

  it('INCREASED when no expected amount is known (confirmed by the chain check)', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock);
    const { events, verifier, settle } = setup(reader, clock);
    reader.credit('Alice', 42n);
    verifier.confirmed(0, null, null);
    await settle();
    expect(events[0]).toMatchObject({ status: 'INCREASED', expected: null, observed: 42n });
  });

  it('UNVERIFIABLE: baseline read at or after the landing slot (it may contain the buy)', async () => {
    const clock = new FakeClock();
    const reader = chainReader(clock, { slot: 2_000n });
    const { events, verifier, settle } = setup(reader, clock);
    reader.credit('Alice', 10n);
    verifier.confirmed(0, 2_000n, 10n);
    await settle();
    expect(events[0]).toMatchObject({ status: 'UNVERIFIABLE', observed: null });
  });

  it('UNVERIFIABLE: no baseline, or every read failed; the error text never leaves', async () => {
    const clock = new FakeClock();
    let first = true;
    const noBase = chainReader(clock, {
      fail: () => {
        const f = first;
        first = false;
        return f;
      },
    });
    const a = setup(noBase, clock);
    a.verifier.confirmed(0, 2_000n, 1n);
    await a.settle();
    expect(a.events[0]?.status).toBe('UNVERIFIABLE');

    let calls = 0;
    const flaky = chainReader(clock, { fail: () => calls++ > 0 });
    const b = setup(flaky, clock);
    b.verifier.confirmed(1, 2_000n, 1n);
    await b.settle();
    expect(b.events[0]?.status).toBe('UNVERIFIABLE');
    expect(
      JSON.stringify(b.events, (_k, v: unknown) => (typeof v === 'bigint' ? 1 : v)),
    ).not.toContain('RPC_UNAVAILABLE');
  });

  it('an unknown wallet index is UNVERIFIABLE, not a crash', async () => {
    const clock = new FakeClock();
    const { events, verifier, settle } = setup(chainReader(clock), clock);
    verifier.confirmed(9, 2_000n, 1n);
    await settle();
    expect(events[0]).toMatchObject({ index: 9, status: 'UNVERIFIABLE' });
  });
});
