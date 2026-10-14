/**
 * Token reads after landed transactions (BUNNDLY-57, D-051): a burst of confirmations must
 * reach the RPC as one read, and reads start at least the gap apart, so 100 wallets landing
 * at once never break the 10 requests a second of the free plan.
 */
import { describe, expect, it } from 'vitest';
import { createBatchQueue } from '../../src/worker/batch-queue.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';

const GAP = 1_000;

function setup() {
  const clock = new FakeClock(true);
  const runs: { at: number; batch: Map<string, number[]> }[] = [];
  const queue = createBatchQueue<string, number>({
    clock,
    gapMs: GAP,
    run: (batch) => {
      runs.push({
        at: clock.now() - T0,
        batch: new Map([...batch].map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
      });
      return Promise.resolve();
    },
  });
  return { clock, runs, queue };
}

describe('batch queue', () => {
  it('a burst of 100 adds at one instant is one run, at once, with every index', async () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.queue.add('mintA', i);
    t.queue.add('mintB', 7);
    await t.clock.runUntil(T0 + 5_000);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.at).toBe(0);
    expect(t.runs[0]?.batch.get('mintA')).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(t.runs[0]?.batch.get('mintB')).toEqual([7]);
  });

  it('adds after a run wait for the gap and share the next run', async () => {
    const t = setup();
    t.queue.add('mintA', 0);
    await t.clock.runUntil(T0 + 100);
    for (let i = 1; i <= 50; i++) t.queue.add('mintA', i);
    await t.clock.runUntil(T0 + 400);
    t.queue.add('mintA', 51);
    await t.clock.runUntil(T0 + 10_000);
    expect(t.runs.map((r) => r.at)).toEqual([0, GAP]);
    expect(t.runs[1]?.batch.get('mintA')).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
  });

  it('after a quiet spell the next run starts at once', async () => {
    const t = setup();
    t.queue.add('mintA', 0);
    await t.clock.runUntil(T0 + 5_000);
    t.queue.add('mintA', 1);
    await t.clock.runUntil(T0 + 5_000);
    expect(t.runs.map((r) => r.at)).toEqual([0, 5_000]);
  });

  it('clear drops what was asked for and not run', async () => {
    const t = setup();
    t.queue.add('mintA', 0);
    await t.clock.runUntil(T0 + 10);
    t.queue.add('mintA', 1);
    t.queue.clear();
    await t.clock.runUntil(T0 + 10_000);
    expect(t.runs).toHaveLength(1);
  });
});
