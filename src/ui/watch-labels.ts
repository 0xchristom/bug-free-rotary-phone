/** Polish labels for mode B (BUNNDLY-35): connection states, detector sources and paths. */
import type { DetectionPath } from '../watcher/detectors/detector.ts';
import type { DetectionSource } from '../watcher/detectors/programs.ts';
import type { StreamStatus } from '../watcher/stream.ts';
import type { DetectionProblem } from '../watcher/watch.ts';
import { base58 } from '@scure/base';
import { ERROR_MESSAGES } from '../core/errors.ts';
import { SOL_MINT } from '../jupiter/client.ts';

export function connectionLabel(status: StreamStatus, attempt: number): string {
  switch (status) {
    case 'connecting':
      return 'Łączenie…';
    case 'connected':
      return 'Połączono';
    case 'reconnecting':
      return `Ponowne łączenie (próba ${String(attempt)})`;
    case 'disconnected':
      return 'Rozłączono';
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
  transaction: 'transakcja',
  'catch-up': 'nadrabianie',
};

export function problemLabel(problem: DetectionProblem): string {
  if (problem === 'STALE') return 'transakcja sprzed uzbrojenia, bez zakupu';
  if (problem === 'DISARMED') return 'rozbrojono przed zakupem';
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
