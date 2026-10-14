/** Stairs fields, plan line, "Starts in" and the Pause button (BUNNDLY-61, mockup v2). */
import { describe, expect, it } from 'vitest';
import {
  durationText,
  parseEvery,
  parsePerStep,
  pauseControl,
  planText,
  stairsPlan,
  stairsRequest,
  startsInText,
} from '../../src/ui/stairs-plan.ts';
import type { BuyStatus } from '../../src/worker/protocol.ts';

describe('the fields', () => {
  it('every: whole seconds from 1 to 86 400 (24 h)', () => {
    expect(parseEvery('6')).toBe(6);
    expect(parseEvery(' 1 ')).toBe(1);
    expect(parseEvery('86400')).toBe(86_400);
    for (const bad of ['0', '86401', '1.5', '-3', '', 'six', '6s', '1e3']) {
      expect(parseEvery(bad), bad).toBeNull();
    }
  });

  it('per step: whole wallets, at least 1', () => {
    expect(parsePerStep('1')).toBe(1);
    expect(parsePerStep('25')).toBe(25);
    for (const bad of ['0', '2.5', '-1', '', 'x']) expect(parsePerStep(bad), bad).toBeNull();
  });

  it('the request carries milliseconds', () => {
    expect(stairsRequest(6, 1)).toEqual({ intervalMs: 6_000, perStep: 1 });
    expect(stairsRequest(86_400, 3)).toEqual({ intervalMs: 86_400_000, perStep: 3 });
  });
});

describe('the plan line', () => {
  it('worked out by hand: steps = ceil(wallets / per step), last at (steps − 1) × every', () => {
    // 10 wallets, 3 per step: 4 steps (3+3+3+1); last at 3 × 6 s = 18 s
    expect(stairsPlan(10, 6, 3)).toEqual({ steps: 4, lastAtMs: 18_000 });
    expect(planText(stairsPlan(10, 6, 3))).toBe('→ 4 steps, last one at +18.0 s');
    // 5 wallets, 1 per step, every 6 s: 5 steps, last at 24 s
    expect(planText(stairsPlan(5, 6, 1))).toBe('→ 5 steps, last one at +24.0 s');
    // 100 wallets, 10 per step, every 30 s: 10 steps, last at 270 s = 4 m 30 s
    expect(planText(stairsPlan(100, 30, 10))).toBe('→ 10 steps, last one at +4 m 30 s');
    // 3 wallets, 5 per step: one step at once
    expect(planText(stairsPlan(3, 6, 5))).toBe('→ 1 step, last one at +0 ms');
  });

  it('no line without selected wallets', () => {
    expect(stairsPlan(0, 6, 1)).toBeNull();
    expect(planText(null)).toBe('');
  });

  it('durations as in the mockup', () => {
    expect(durationText(850)).toBe('850 ms');
    expect(durationText(4_000)).toBe('4.0 s');
    expect(durationText(59_900)).toBe('59.9 s');
    expect(durationText(125_000)).toBe('2 m 5 s');
  });
});

describe('a wallet waiting for its step', () => {
  it('counts down in whole seconds, rounded up; Paused while paused', () => {
    expect(startsInText(10_000, 0, false)).toBe('Starts in 00:10');
    expect(startsInText(10_000, 9_001, false)).toBe('Starts in 00:01');
    expect(startsInText(3_725_000, 0, false)).toBe('Starts in 62:05');
    expect(startsInText(10_000, 12_000, false)).toBe('Starts in 00:00');
    expect(startsInText(10_000, 0, true)).toBe('Paused');
  });
});

describe('the Pause / Resume button', () => {
  const run = (extra: Partial<BuyStatus>): BuyStatus => ({
    runId: 1,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    dryRun: false,
    wallets: 5,
    accepting: true,
    ...extra,
  });
  const stairs = { intervalMs: 6_000, perStep: 1 };

  it('Pause on a running Stairs run with wallets waiting; Resume once paused', () => {
    expect(pauseControl(run({ stairs, paused: false }), true)).toEqual({
      label: 'Pause',
      request: 'pauseStairs',
    });
    expect(pauseControl(run({ stairs, paused: true }), true)).toEqual({
      label: 'Resume',
      request: 'resumeStairs',
    });
  });

  it('none for Immediate, after STOP, with no wallet waiting, or without a run', () => {
    expect(pauseControl(run({}), true)).toBeNull();
    expect(pauseControl(run({ stairs, paused: false, accepting: false }), true)).toBeNull();
    expect(pauseControl(run({ stairs, paused: false }), false)).toBeNull();
    expect(pauseControl(null, true)).toBeNull();
  });
});
