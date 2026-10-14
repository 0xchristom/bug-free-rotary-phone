/**
 * Fill of one wallet (BUNNDLY-56): the bar's position, its tone and the text beside it,
 * from the wallet's state and the chain check. One source for the row, the state chip and
 * the fleet bar in the summary.
 *
 * 100 and green mean bought (or sold) and confirmed by reading the chain, nothing else.
 * Before the end the bar stands at fixed stage positions (not a share of the trade).
 */
import {
  FAIL_MESSAGES,
  SKIP_MESSAGES,
  UNKNOWN_MESSAGES,
  type Side,
  type VerifyStatus,
  type WalletQuote,
  type WalletReason,
  type WalletResult,
  type WalletState,
} from '../executor/index.ts';
import { formatUnits } from './sol.ts';
import { startsInText } from './stairs-plan.ts';

export type FillTone =
  'idle' | 'watch' | 'run' | 'ok' | 'unverified' | 'warn' | 'bad' | 'mute' | 'sim';

export interface Fill {
  /** 0–100: the bar's width and `aria-valuenow`. */
  readonly percent: number;
  readonly tone: FillTone;
  /** Shown beside the bar; with the tone, colour is never the only signal. */
  readonly label: string;
}

export interface FillInput {
  readonly state: WalletState;
  readonly reason: WalletReason | null;
  /** Token balance check after CONFIRMED; null until it is read. */
  readonly verify: VerifyStatus | null;
  readonly dryRun: boolean;
  readonly side: Side;
  /**
   * The executor's attempt number (1 on the first `/order`). QUEUED after an attempt means
   * the wallet waits to try again; from the 2nd attempt on the stage says which one.
   */
  readonly attempt?: number;
  /** SCHEDULED (Stairs): when the step starts, the clock and whether the run is paused. */
  readonly scheduledAt?: number | null;
  readonly now?: number;
  readonly paused?: boolean;
}

/** Bar positions of the stages: where the wallet is, not how much is bought. */
export const STAGE_PERCENT = {
  QUEUED: 5,
  QUOTING: 20,
  SIGNING: 35,
  SUBMITTED: 60,
  CHECKING: 80,
  VERIFYING: 90,
} as const;

function reasonText(reason: WalletReason | null, fallback: string): string {
  if (reason === null) return fallback;
  switch (reason.kind) {
    case 'SKIPPED':
      return SKIP_MESSAGES[reason.code];
    case 'FAILED':
      return FAIL_MESSAGES[reason.code];
    case 'UNKNOWN':
      return UNKNOWN_MESSAGES[reason.code];
  }
}

/** CONFIRMED by Jupiter: green only once the chain read agrees. */
function confirmedFill(verify: VerifyStatus | null, side: Side): Fill {
  switch (verify) {
    case null:
      return { percent: STAGE_PERCENT.VERIFYING, tone: 'run', label: 'Verifying' };
    case 'MATCH':
    case 'INCREASED':
      return { percent: 100, tone: 'ok', label: side === 'sell' ? 'Sold' : 'Filled' };
    case 'UNVERIFIABLE':
      return { percent: 100, tone: 'unverified', label: 'Unverified' };
    case 'MISMATCH':
      return { percent: 100, tone: 'warn', label: 'Amount differs' };
    case 'NO_INCREASE':
      return { percent: 0, tone: 'bad', label: 'Not on chain' };
  }
}

function rawFill(input: FillInput): Fill {
  const { state, reason, verify } = input;
  switch (state) {
    case 'IDLE':
      return { percent: 0, tone: 'idle', label: 'Waiting' };
    case 'SCHEDULED': {
      const at = input.scheduledAt ?? null;
      const label =
        at === null ? 'Scheduled' : startsInText(at, input.now ?? at, input.paused === true);
      return { percent: 0, tone: 'watch', label };
    }
    case 'QUEUED':
      // Back in the queue after an attempt (a transient failure, no route yet, rate limit).
      return (input.attempt ?? 0) >= 1
        ? { percent: STAGE_PERCENT.QUEUED, tone: 'run', label: 'Retrying' }
        : { percent: STAGE_PERCENT.QUEUED, tone: 'run', label: 'Queued' };
    case 'QUOTING':
      return { percent: STAGE_PERCENT.QUOTING, tone: 'run', label: 'Quote' };
    case 'SIGNING':
      return { percent: STAGE_PERCENT.SIGNING, tone: 'run', label: 'Signing' };
    case 'SUBMITTED':
      return { percent: STAGE_PERCENT.SUBMITTED, tone: 'run', label: 'Sent' };
    case 'CONFIRMED':
      return confirmedFill(verify, input.side);
    case 'FAILED':
      return { percent: 0, tone: 'bad', label: reasonText(reason, 'Failed') };
    case 'SKIPPED':
      if (reason?.code === 'DRY_RUN') return { percent: 100, tone: 'sim', label: 'Simulated' };
      return { percent: 0, tone: 'mute', label: reasonText(reason, 'Skipped') };
    case 'UNKNOWN':
      // Still in the pipeline while the chain is checked (D-030); final otherwise.
      if (reason?.code === 'EXECUTE_NO_ANSWER') {
        return { percent: STAGE_PERCENT.CHECKING, tone: 'run', label: 'Checking chain' };
      }
      return { percent: 0, tone: 'warn', label: reasonText(reason, 'Unknown') };
  }
}

/** "2nd", "3rd", "4th", "11th", "21st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${String(n)}th`;
  switch (n % 10) {
    case 1:
      return `${String(n)}st`;
    case 2:
      return `${String(n)}nd`;
    case 3:
      return `${String(n)}rd`;
    default:
      return `${String(n)}th`;
  }
}

/** A stage of the 2nd or a later attempt says so: "Quote · 2nd attempt". */
function withAttempt(fill: Fill, input: FillInput): Fill {
  const attempt = input.attempt ?? 0;
  if (attempt < 2 || fill.tone !== 'run' || input.state === 'QUEUED') return fill;
  return { ...fill, label: `${fill.label} · ${ordinal(attempt)} attempt` };
}

/** The wallet's fill. In DRY-RUN nothing is ever green or "Filled". */
export function fillOf(input: FillInput): Fill {
  const fill = withAttempt(rawFill(input), input);
  if (input.dryRun && (fill.tone === 'ok' || fill.label === 'Filled' || fill.label === 'Sold')) {
    return { percent: 100, tone: 'sim', label: 'Simulated' };
  }
  return fill;
}

export interface TokensText {
  /** "1234.5", or "≈ 1234.5" for an estimate (a DRY-RUN quote). */
  readonly text: string;
  /** The token balance read from the chain agrees. */
  readonly confirmed: boolean;
}

/**
 * Tokens bought (or sold) beside the bar: from `totalOutputAmount` (`totalInputAmount`
 * for a sell) as soon as `/execute` answers; in DRY-RUN the quote, marked "≈". Null when
 * there is no amount yet or the mint's decimals are not known.
 */
export function tokensText(
  row: {
    readonly quote: WalletQuote | null;
    readonly result: WalletResult | null;
    readonly verify: VerifyStatus | null;
  },
  decimals: number | null,
  dryRun: boolean,
  side: Side,
): TokensText | null {
  if (decimals === null) return null;
  const selling = side === 'sell';
  if (dryRun) {
    const quoted = selling ? row.quote?.inAmount : row.quote?.outAmount;
    return quoted === undefined
      ? null
      : { text: `≈ ${formatUnits(quoted, decimals)}`, confirmed: false };
  }
  const amount = selling ? row.result?.totalInputAmount : row.result?.totalOutputAmount;
  if (amount === undefined || amount === null) return null;
  return {
    text: formatUnits(amount, decimals),
    confirmed: row.verify === 'MATCH',
  };
}

/** The parts of the fleet bar: one segment per selected wallet. */
export type FleetPart = 'filled' | 'inFlight' | 'failed' | 'skipped' | 'waiting';

export function fleetPart(fill: Fill): FleetPart {
  switch (fill.tone) {
    case 'ok':
    case 'unverified':
    case 'sim':
      return 'filled';
    case 'run':
    case 'watch':
      return 'inFlight';
    case 'bad':
    case 'warn':
      return 'failed';
    case 'mute':
      return 'skipped';
    case 'idle':
      return 'waiting';
  }
}

export interface FleetFill {
  readonly segments: readonly FleetPart[];
  readonly counts: Readonly<Record<FleetPart, number>>;
  /** "Fleet fill · 3 of 10 filled · 4 in flight · 1 failed · 2 skipped". */
  readonly text: string;
}

export function fleetFill(fills: readonly Fill[]): FleetFill {
  const segments = fills.map(fleetPart);
  const counts: Record<FleetPart, number> = {
    filled: 0,
    inFlight: 0,
    failed: 0,
    skipped: 0,
    waiting: 0,
  };
  for (const part of segments) counts[part] += 1;
  let text = `Fleet fill · ${String(counts.filled)} of ${String(fills.length)} filled`;
  if (counts.inFlight > 0) text += ` · ${String(counts.inFlight)} in flight`;
  if (counts.failed > 0) text += ` · ${String(counts.failed)} failed`;
  if (counts.skipped > 0) text += ` · ${String(counts.skipped)} skipped`;
  return { segments, counts, text };
}
