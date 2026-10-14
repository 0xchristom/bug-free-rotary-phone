/** Labels for mode B (BUNNDLY-35): connection states, detector sources and paths. */
import type { DetectionPath } from '../watcher/detectors/detector.ts';
import type { DetectionSource } from '../watcher/detectors/programs.ts';
import type { StreamStatus } from '../watcher/stream.ts';
import type { DetectionProblem, WatchDetection } from '../watcher/watch.ts';
import { base58 } from '@scure/base';
import { ERROR_MESSAGES } from '../core/errors.ts';
import { SOL_MINT } from '../jupiter/client.ts';

export function connectionLabel(status: StreamStatus, attempt: number): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return `Reconnecting (attempt ${String(attempt)})`;
    case 'disconnected':
      return 'Disconnected';
  }
}

/** CSS class of the state colour. */
export function connectionTone(status: StreamStatus): 'ok' | 'wait' | 'bad' {
  if (status === 'connected') return 'ok';
  if (status === 'connecting') return 'wait';
  return 'bad';
}

export const SOURCE_LABELS: Readonly<Record<DetectionSource, string>> = {
  'pump.fun': 'pump.fun',
  'raydium-launchlab': 'LaunchLab',
  'meteora-dbc': 'DBC',
  'initialize-mint': 'InitializeMint',
};

export const PATH_LABELS: Readonly<Record<DetectionPath, string>> = {
  log: 'log',
  transaction: 'transaction',
  'catch-up': 'catch-up',
};

/** Time since arming as mm:ss (BUNNDLY-91); minutes go past 59, a negative span shows 00:00. */
export function armedForLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The line after a detection (BUNNDLY-91), from the worker's data only: the slot of the
 * log notification or transaction, and the worker's time from the log to the first
 * `/order`. What the worker did not report is said, never filled in.
 */
export function detectionLine(d: Pick<WatchDetection, 'slot' | 'reactionMs'>): string {
  const slot =
    d.slot === null ? 'Token detected, slot unknown' : `Token detected in slot ${String(d.slot)}`;
  const sent =
    d.reactionMs === null
      ? 'first buy not sent yet'
      : `first buy sent +${String(Math.round(d.reactionMs))} ms`;
  return `${slot} · ${sent}`;
}

/** Why settings cannot change now: the armed watcher buys with what was confirmed. */
export const WATCH_FROZEN = 'Disarm the watcher to change the mode or the settings.';

export function problemLabel(problem: DetectionProblem): string {
  if (problem === 'STALE') return 'transaction from before arming, no buy';
  if (problem === 'DISARMED') return 'disarmed before the buy';
  return ERROR_MESSAGES[problem];
}

/** A creator address: base58 of exactly 32 bytes, not the SOL mint. */
export function isCreatorAddress(text: string): boolean {
  if (text === SOL_MINT) return false;
  try {
    return base58.decode(text).length === 32;
  } catch {
    return false;
  }
}
