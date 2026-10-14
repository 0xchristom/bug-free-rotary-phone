/**
 * Fill of a wallet and the fleet bar (BUNNDLY-56). Every expected percent, tone and label
 * is written here by hand from the task's list, never taken from the function.
 */
import { describe, expect, it } from 'vitest';
import type {
  VerifyStatus,
  WalletQuote,
  WalletReason,
  WalletResult,
  WalletState,
} from '../../src/executor/index.ts';
import {
  ARMED_FILL,
  fillOf,
  fleetFill,
  ordinal,
  tokensText,
  type Fill,
  type FillInput,
} from '../../src/ui/fill.ts';

const skipped = (code: 'DRY_RUN' | 'INSUFFICIENT_SOL' | 'STOPPED'): WalletReason => ({
  kind: 'SKIPPED',
  code,
  detail: null,
});
const failed: WalletReason = { kind: 'FAILED', code: 'MAX_ATTEMPTS', detail: null };
const noAnswer: WalletReason = { kind: 'UNKNOWN', code: 'EXECUTE_NO_ANSWER', detail: null };
const unresolved: WalletReason = { kind: 'UNKNOWN', code: 'LANDING_UNRESOLVED', detail: null };

const live = (
  state: WalletState,
  verify: VerifyStatus | null = null,
  reason: WalletReason | null = null,
): FillInput => ({ state, reason, verify, dryRun: false, side: 'buy' });

describe('fill of one wallet: the table from the task', () => {
  const rows: [string, FillInput, Fill][] = [
    ['IDLE', live('IDLE'), { percent: 0, tone: 'idle', label: 'Waiting' }],
    ['QUEUED', live('QUEUED'), { percent: 5, tone: 'run', label: 'Queued' }],
    ['QUOTING', live('QUOTING'), { percent: 20, tone: 'run', label: 'Quote' }],
    ['SIGNING', live('SIGNING'), { percent: 35, tone: 'run', label: 'Signing' }],
    ['SUBMITTED', live('SUBMITTED'), { percent: 60, tone: 'run', label: 'Sent' }],
    [
      'UNKNOWN while the chain is checked',
      live('UNKNOWN', null, noAnswer),
      { percent: 80, tone: 'run', label: 'Checking chain' },
    ],
    [
      'CONFIRMED before the RPC read',
      live('CONFIRMED'),
      { percent: 90, tone: 'run', label: 'Verifying' },
    ],
    [
      'CONFIRMED + MATCH',
      live('CONFIRMED', 'MATCH'),
      { percent: 100, tone: 'ok', label: 'Filled' },
    ],
    [
      'CONFIRMED + INCREASED',
      live('CONFIRMED', 'INCREASED'),
      { percent: 100, tone: 'ok', label: 'Filled' },
    ],
    [
      'CONFIRMED + UNVERIFIABLE',
      live('CONFIRMED', 'UNVERIFIABLE'),
      { percent: 100, tone: 'unverified', label: 'Unverified' },
    ],
    [
      'CONFIRMED + MISMATCH',
      live('CONFIRMED', 'MISMATCH'),
      { percent: 100, tone: 'warn', label: 'Amount differs' },
    ],
    [
      'CONFIRMED + NO_INCREASE',
      live('CONFIRMED', 'NO_INCREASE'),
      { percent: 0, tone: 'bad', label: 'Not on chain' },
    ],
    [
      'FAILED',
      live('FAILED', null, failed),
      { percent: 0, tone: 'bad', label: 'All attempts are used up.' },
    ],
    [
      'SKIPPED',
      live('SKIPPED', null, skipped('INSUFFICIENT_SOL')),
      {
        percent: 0,
        tone: 'mute',
        label: 'Not enough SOL: the balance is below max spend plus the reserve.',
      },
    ],
    [
      'UNKNOWN, final',
      live('UNKNOWN', null, unresolved),
      {
        percent: 0,
        tone: 'warn',
        label:
          'Could not tell whether the transaction landed. The wallet does not try again; check it in the explorer.',
      },
    ],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    expect(fillOf(input)).toEqual(expected);
  });

  it('a sell confirmed on the chain says "Sold"', () => {
    expect(fillOf({ ...live('CONFIRMED', 'MATCH'), side: 'sell' })).toEqual({
      percent: 100,
      tone: 'ok',
      label: 'Sold',
    });
  });

  it('CONFIRMED is not 100 until the chain read; MATCH makes it 100', () => {
    expect(fillOf(live('CONFIRMED')).percent).toBe(90);
    expect(fillOf(live('CONFIRMED')).tone).not.toBe('ok');
    expect(fillOf(live('CONFIRMED', 'MATCH')).percent).toBe(100);
  });

  it('a different amount or no increase is never green', () => {
    for (const verify of ['MISMATCH', 'NO_INCREASE'] as const) {
      for (const side of ['buy', 'sell'] as const) {
        const got = fillOf({ ...live('CONFIRMED', verify), side });
        expect(got.tone, `${verify} ${side}`).not.toBe('ok');
        expect(['Filled', 'Sold']).not.toContain(got.label);
      }
    }
  });

  it('SCHEDULED shows when its step starts, or Paused', () => {
    const at = 1_000_000;
    const scheduled = (now: number, paused: boolean): FillInput => ({
      ...live('SCHEDULED'),
      scheduledAt: at,
      now,
      paused,
    });
    // 65 s before: 01:05; 0.2 s before rounds up to 00:01; past the time: 00:00
    expect(fillOf(scheduled(at - 65_000, false))).toEqual({
      percent: 0,
      tone: 'watch',
      label: 'Starts in 01:05',
    });
    expect(fillOf(scheduled(at - 200, false)).label).toBe('Starts in 00:01');
    expect(fillOf(scheduled(at + 5_000, false)).label).toBe('Starts in 00:00');
    expect(fillOf(scheduled(at - 65_000, true)).label).toBe('Paused');
    expect(fillOf(live('SCHEDULED')).label).toBe('Scheduled');
  });
});

describe('DRY-RUN', () => {
  const states: [WalletState, VerifyStatus | null, WalletReason | null][] = [
    ['IDLE', null, null],
    ['QUEUED', null, null],
    ['QUOTING', null, null],
    ['SIGNING', null, null],
    ['SKIPPED', null, skipped('DRY_RUN')],
    ['SKIPPED', null, skipped('STOPPED')],
    ['FAILED', null, failed],
    // never happens in DRY-RUN, and must still not look like a real buy
    ['CONFIRMED', 'MATCH', null],
    ['CONFIRMED', 'INCREASED', null],
  ];

  it('no wallet is ever green or "Filled"', () => {
    for (const [state, verify, reason] of states) {
      for (const side of ['buy', 'sell'] as const) {
        const got = fillOf({ state, reason, verify, dryRun: true, side });
        expect(got.tone, `${state} ${String(verify)}`).not.toBe('ok');
        expect(['Filled', 'Sold']).not.toContain(got.label);
      }
    }
  });

  it('the end of a DRY-RUN wallet is a simulated 100', () => {
    expect(fillOf({ ...live('SKIPPED', null, skipped('DRY_RUN')), dryRun: true })).toEqual({
      percent: 100,
      tone: 'sim',
      label: 'Simulated',
    });
  });
});

describe('tokens beside the bar', () => {
  const quote: WalletQuote = { inAmount: 50_000_000n, outAmount: 987_654_321n, router: 'iris' };
  const result = (out: bigint | null, input: bigint | null = null): WalletResult => ({
    signature: 'sig',
    slot: 1n,
    totalInputAmount: input,
    totalOutputAmount: out,
  });

  it('the amount from the fixture over 10^decimals, worked out by hand (6 and 9 places)', () => {
    const row = { quote, result: result(1_234_567_890n), verify: 'MATCH' as const };
    // 1 234 567 890 / 10^6 = 1234.56789; / 10^9 = 1.23456789
    expect(tokensText(row, 6, false, 'buy')).toEqual({ text: '1234.56789', confirmed: true });
    expect(tokensText(row, 9, false, 'buy')).toEqual({ text: '1.23456789', confirmed: true });
  });

  it('marked confirmed only after the chain read agrees', () => {
    const row = { quote, result: result(2_500_000n), verify: null };
    expect(tokensText(row, 6, false, 'buy')).toEqual({ text: '2.5', confirmed: false });
    expect(tokensText({ ...row, verify: 'MISMATCH' }, 6, false, 'buy')?.confirmed).toBe(false);
  });

  it('DRY-RUN: the quote with "≈"', () => {
    // 987 654 321 / 10^6 = 987.654321
    const row = { quote, result: null, verify: null };
    expect(tokensText(row, 6, true, 'buy')).toEqual({ text: '≈ 987.654321', confirmed: false });
  });

  it('a sell shows the tokens sold (the input side)', () => {
    const row = { quote, result: result(10n, 3_000_000_000n), verify: 'MATCH' as const };
    // 3 000 000 000 / 10^9 = 3
    expect(tokensText(row, 9, false, 'sell')).toEqual({ text: '3', confirmed: true });
    // DRY-RUN sell: quote.inAmount 50 000 000 / 10^6 = 50
    expect(tokensText({ ...row, result: null }, 6, true, 'sell')?.text).toBe('≈ 50');
  });

  it('nothing before an amount or without the decimals', () => {
    expect(tokensText({ quote: null, result: null, verify: null }, 6, false, 'buy')).toBeNull();
    expect(tokensText({ quote, result: result(null), verify: null }, 6, false, 'buy')).toBeNull();
    expect(tokensText({ quote, result: result(5n), verify: null }, null, false, 'buy')).toBeNull();
  });
});

describe('fleet bar', () => {
  it('mixed states: the parts add up to the selected wallets, the text counts them', () => {
    const fills = [
      live('CONFIRMED', 'MATCH'),
      live('CONFIRMED', 'UNVERIFIABLE'),
      live('CONFIRMED'),
      live('SUBMITTED'),
      live('SCHEDULED'),
      live('FAILED', null, failed),
      live('CONFIRMED', 'NO_INCREASE'),
      live('UNKNOWN', null, unresolved),
      live('SKIPPED', null, skipped('INSUFFICIENT_SOL')),
      live('IDLE'),
    ].map(fillOf);
    const fleet = fleetFill(fills);
    expect(fleet.segments).toEqual([
      'filled',
      'filled',
      'inFlight',
      'inFlight',
      'inFlight',
      'failed',
      'failed',
      'failed',
      'skipped',
      'waiting',
    ]);
    expect(fleet.counts).toEqual({ filled: 2, inFlight: 3, failed: 3, skipped: 1, waiting: 1 });
    const sum = Object.values(fleet.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(10);
    expect(fleet.text).toBe('Fleet fill · 2 of 10 filled · 3 in flight · 3 failed · 1 skipped');
  });

  it('nothing started: only the count of filled', () => {
    expect(fleetFill([live('IDLE'), live('IDLE')].map(fillOf)).text).toBe(
      'Fleet fill · 0 of 2 filled',
    );
  });
});

// BUNNDLY-89: a retry is visible. The executor numbers attempts from 1 on the first /order
// (QUEUED before it carries 0); QUEUED after an attempt waits to try again.
describe('retry and attempt number in the fill (BUNNDLY-89)', () => {
  const at = (state: WalletState, attempt: number, reason: WalletReason | null = null) => ({
    ...live(state, null, reason),
    attempt,
  });
  const rows: [string, FillInput, Fill][] = [
    ['QUEUED before any attempt', at('QUEUED', 0), { percent: 5, tone: 'run', label: 'Queued' }],
    [
      'QUEUED after the 1st attempt',
      at('QUEUED', 1),
      { percent: 5, tone: 'run', label: 'Retrying' },
    ],
    [
      'QUEUED after the 2nd attempt',
      at('QUEUED', 2),
      { percent: 5, tone: 'run', label: 'Retrying' },
    ],
    ['QUOTING, 1st attempt', at('QUOTING', 1), { percent: 20, tone: 'run', label: 'Quote' }],
    [
      'QUOTING, 2nd attempt',
      at('QUOTING', 2),
      { percent: 20, tone: 'run', label: 'Quote · 2nd attempt' },
    ],
    [
      'SIGNING, 2nd attempt',
      at('SIGNING', 2),
      { percent: 35, tone: 'run', label: 'Signing · 2nd attempt' },
    ],
    [
      'SUBMITTED, 3rd attempt',
      at('SUBMITTED', 3),
      { percent: 60, tone: 'run', label: 'Sent · 3rd attempt' },
    ],
    [
      'checking the chain, 2nd attempt',
      at('UNKNOWN', 2, noAnswer),
      { percent: 80, tone: 'run', label: 'Checking chain · 2nd attempt' },
    ],
    [
      'FAILED after 3 attempts: the reason only',
      at('FAILED', 3, failed),
      { percent: 0, tone: 'bad', label: 'All attempts are used up.' },
    ],
  ];
  it.each(rows)('%s', (_name, input, expected) => {
    expect(fillOf(input)).toEqual(expected);
  });

  it('a retrying wallet counts as in flight in the fleet bar', () => {
    const fleet = fleetFill([fillOf(at('QUEUED', 1)), fillOf(at('QUOTING', 2))]);
    expect(fleet.counts.inFlight).toBe(2);
    expect(fleet.counts.failed).toBe(0);
  });

  it('DRY-RUN: the 2nd attempt is said on the stage, the end stays Simulated', () => {
    expect(fillOf({ ...at('SIGNING', 2), dryRun: true }).label).toBe('Signing · 2nd attempt');
    expect(fillOf({ ...at('SKIPPED', 2, skipped('DRY_RUN')), dryRun: true })).toEqual({
      percent: 100,
      tone: 'sim',
      label: 'Simulated',
    });
  });

  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [10, '10th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [111, '111th'],
  ])('ordinal(%i) is %s', (n, text) => {
    expect(ordinal(n)).toBe(text);
  });
});

describe('an armed wallet (BUNNDLY-88)', () => {
  it('waits for the creator’s token at 0 %, in the watch tone, and counts as in flight', () => {
    expect(ARMED_FILL).toEqual({
      percent: 0,
      tone: 'watch',
      label: 'Waiting for the creator’s token',
    });
    expect(fleetFill([ARMED_FILL, ARMED_FILL]).text).toBe(
      'Fleet fill · 0 of 2 filled · 2 in flight',
    );
  });
});
