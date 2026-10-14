/**
 * Stairs in the command bar (BUNNDLY-61, mockup v2): the "every N s · M per step" fields,
 * the plan line beside them, the wallet's "Starts in" caption and the Pause / Resume
 * button. Pure: the bar and the table only show what these return.
 */
import { STAIRS_INTERVAL_MAX_MS, STAIRS_INTERVAL_MIN_MS } from '../executor/index.ts';
import type { StairsOptions } from '../executor/index.ts';
import type { BuyStatus } from '../worker/protocol.ts';

export const EVERY_MIN_S = STAIRS_INTERVAL_MIN_MS / 1_000;
export const EVERY_MAX_S = STAIRS_INTERVAL_MAX_MS / 1_000;
/** No fleet has more wallets than this; a bigger step is the same as Immediate. */
export const PER_STEP_MAX = 10_000;

/** Whole number from a field: digits only, within [min, max]; otherwise null. */
function wholeNumber(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,6}$/u.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Seconds between steps, 1 s to 24 h. */
export function parseEvery(text: string): number | null {
  return wholeNumber(text, EVERY_MIN_S, EVERY_MAX_S);
}

/** Wallets per step, at least 1. */
export function parsePerStep(text: string): number | null {
  return wholeNumber(text, 1, PER_STEP_MAX);
}

/** What the vault gets for a Stairs run. */
export function stairsRequest(everyS: number, perStep: number): StairsOptions {
  return { intervalMs: everyS * 1_000, perStep };
}

export interface StairsPlan {
  readonly steps: number;
  /** When the last step starts, after the first. */
  readonly lastAtMs: number;
}

/** Steps for `selected` wallets; null without wallets. */
export function stairsPlan(selected: number, everyS: number, perStep: number): StairsPlan | null {
  if (selected <= 0) return null;
  const steps = Math.ceil(selected / perStep);
  return { steps, lastAtMs: (steps - 1) * everyS * 1_000 };
}

/** "850 ms", "4.0 s", "2 m 5 s", as in the mockup. */
export function durationText(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${String(Math.floor(ms / 60_000))} m ${String(Math.round((ms % 60_000) / 1_000))} s`;
}

/** "→ 5 steps, last one at +24.0 s"; empty without wallets. */
export function planText(plan: StairsPlan | null): string {
  if (plan === null) return '';
  const steps = `${String(plan.steps)} step${plan.steps === 1 ? '' : 's'}`;
  return `→ ${steps}, last one at +${durationText(plan.lastAtMs)}`;
}

/** Caption of a wallet waiting for its step: "Starts in 01:05" or "Paused". */
export function startsInText(scheduledAt: number, now: number, paused: boolean): string {
  if (paused) return 'Paused';
  const s = Math.max(0, Math.ceil((scheduledAt - now) / 1_000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `Starts in ${mm}:${ss}`;
}

export interface PauseControl {
  readonly label: 'Pause' | 'Resume';
  readonly request: 'pauseStairs' | 'resumeStairs';
}

/**
 * The Pause / Resume button: only for a Stairs run that still has wallets waiting for a
 * step and still takes commands (not after STOP).
 */
export function pauseControl(buy: BuyStatus | null, waiting: boolean): PauseControl | null {
  if (buy?.stairs === undefined || !buy.accepting || !waiting) return null;
  return buy.paused === true
    ? { label: 'Resume', request: 'resumeStairs' }
    : { label: 'Pause', request: 'pauseStairs' };
}
