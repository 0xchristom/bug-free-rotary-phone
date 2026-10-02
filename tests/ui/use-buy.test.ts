/** Buy view reducer (BUNNDLY-27): counts, timers, row identity for memoized rows. */
import { describe, expect, it } from 'vitest';
import type { ExecutorEvent, RunEvent, WalletEvent } from '../../src/executor/index.ts';
import { EMPTY_BUY, reduceBuy } from '../../src/ui/use-buy.ts';
import { transactionUrl } from '../../src/ui/explorer.ts';

const SIG = '5'.repeat(88);

function run(runId: number, phase: RunEvent['phase'] = 'started'): RunEvent {
  return {
    kind: 'run',
    runId,
    at: 0,
    phase,
    mint: 'Mint',
    dryRun: false,
    wallets: 3,
    counts: {
      IDLE: 0,
      QUEUED: 0,
      QUOTING: 0,
      SIGNING: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
      UNKNOWN: 0,
      SKIPPED: 0,
    },
  };
}

function wallet(
  index: number,
  state: WalletEvent['state'],
  sinceStartMs = 100,
  extra: Partial<WalletEvent> = {},
): WalletEvent {
  return {
    kind: 'wallet',
    runId: 1,
    at: 0,
    index,
    state,
    attempt: 1,
    reason: null,
    quote: null,
    result: null,
    times: { orderMs: null, signMs: null, executeMs: null, sinceStartMs },
    ...extra,
  };
}

describe('reduceBuy', () => {
  it('counts confirmed, in progress and failed or skipped; first and last confirmation', () => {
    const events: ExecutorEvent[] = [
      run(1),
      wallet(0, 'QUEUED', 0),
      wallet(1, 'QUEUED', 0),
      wallet(2, 'SKIPPED', 0, {
        reason: { kind: 'SKIPPED', code: 'INSUFFICIENT_SOL', detail: null },
      }),
      wallet(0, 'CONFIRMED', 1_200),
      wallet(1, 'UNKNOWN', 1_500, {
        reason: { kind: 'UNKNOWN', code: 'EXECUTE_NO_ANSWER', detail: 'TIMEOUT' },
      }),
    ];
    const v = reduceBuy(EMPTY_BUY, events);
    expect(v.counts).toEqual({ confirmed: 1, inProgress: 1, failedOrSkipped: 1 });
    expect(v.run).toMatchObject({ runId: 1, firstConfirmMs: 1_200, lastConfirmMs: 1_200 });

    const later = reduceBuy(v, [wallet(1, 'CONFIRMED', 9_000), run(1, 'finished')]);
    expect(later.counts).toEqual({ confirmed: 2, inProgress: 0, failedOrSkipped: 1 });
    expect(later.run).toMatchObject({
      phase: 'finished',
      firstConfirmMs: 1_200,
      lastConfirmMs: 9_000,
    });
  });

  it('a row object changes only when its wallet has an event', () => {
    const v = reduceBuy(EMPTY_BUY, [run(1), wallet(0, 'QUEUED'), wallet(1, 'QUEUED')]);
    const next = reduceBuy(v, [wallet(1, 'QUOTING')]);
    expect(next.rows.get(0)).toBe(v.rows.get(0));
    expect(next.rows.get(1)).not.toBe(v.rows.get(1));
  });

  it('verification marks the row; events of an older run are ignored; a new run resets', () => {
    let v = reduceBuy(EMPTY_BUY, [run(1), wallet(0, 'CONFIRMED')]);
    v = reduceBuy(v, [
      { kind: 'verify', runId: 1, at: 0, index: 0, status: 'MATCH', expected: 1n, observed: 1n },
    ]);
    expect(v.rows.get(0)?.verify).toBe('MATCH');
    expect(reduceBuy(v, [{ ...wallet(0, 'FAILED'), runId: 0 }])).toBe(v);
    const fresh = reduceBuy(v, [run(2)]);
    expect(fresh.rows.size).toBe(0);
    expect(fresh.run?.runId).toBe(2);
  });
});

describe('explorer links', () => {
  it('per explorer from Settings; only plain signatures', () => {
    expect(transactionUrl('solscan', SIG)).toBe(`https://solscan.io/tx/${SIG}`);
    expect(transactionUrl('orb', SIG)).toBe(`https://orb.helius.dev/tx/${SIG}`);
    expect(transactionUrl('solana-explorer', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}`);
    expect(transactionUrl('solscan', 'javascript:alert(1)')).toBeNull();
    expect(transactionUrl('solscan', `${SIG}?x=1`)).toBeNull();
  });
});
