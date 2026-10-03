/**
 * Operations log (SPEC 3.5 and 3.6, BUNNDLY-25, D-031): one entry per executor event,
 * exported as CSV or JSON. Built from events only, which carry no keys and no signed
 * transactions; the log adds public addresses and nothing else.
 *
 * Amounts stay exact: bigint, written as whole numbers (lamports, raw token units).
 * CSV cells that a spreadsheet would run as a formula get a leading apostrophe.
 */
import { ERROR_MESSAGES } from '../core/errors.ts';
import type { DetectionProblem, WatchEvent } from '../watcher/watch.ts';
import { FAIL_MESSAGES, SKIP_MESSAGES, UNKNOWN_MESSAGES } from './states.ts';
import { VERIFY_MESSAGES } from './verify.ts';
import type { ExecutorEvent } from './executor.ts';

/** What the log records: the executor's events and, in mode B, the watcher's. */
export type LoggedEvent = ExecutorEvent | WatchEvent;

export interface LogEntry {
  /** ISO 8601, UTC. */
  readonly time: string;
  /** Null for watcher entries that belong to no buy (arm, disarm, connection). */
  readonly runId: number | null;
  readonly event: 'run' | 'wallet' | 'verify' | 'watch';
  /** Run phase, wallet state, verification status, or the watcher event. */
  readonly state: string;
  readonly wallet: number | null;
  readonly address: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly message: string | null;
  readonly attempt: number | null;
  /** Quote: lamports in, raw token units out. */
  readonly quoteIn: bigint | null;
  readonly quoteOut: bigint | null;
  readonly router: string | null;
  readonly signature: string | null;
  readonly slot: bigint | null;
  /** `/execute`: SOL spent (lamports) and tokens received (raw units). */
  readonly spent: bigint | null;
  readonly received: bigint | null;
  /** SOL per whole token, when the token's decimals are known. */
  readonly price: string | null;
  readonly orderMs: number | null;
  readonly signMs: number | null;
  readonly executeMs: number | null;
  /** Verification: expected and observed token growth. */
  readonly expected: bigint | null;
  readonly observed: bigint | null;
  /** Mode B: the detected mint, its detector and path, and log → first `/order`. */
  readonly mint: string | null;
  readonly source: string | null;
  readonly path: string | null;
  readonly reactionMs: number | null;
}

export const LOG_COLUMNS = [
  'time',
  'runId',
  'event',
  'state',
  'wallet',
  'address',
  'reason',
  'detail',
  'message',
  'attempt',
  'quoteIn',
  'quoteOut',
  'router',
  'signature',
  'slot',
  'spent',
  'received',
  'price',
  'orderMs',
  'signMs',
  'executeMs',
  'expected',
  'observed',
  'mint',
  'source',
  'path',
  'reactionMs',
] as const satisfies readonly (keyof LogEntry)[];

const LAMPORTS_DECIMALS = 9n;
/** Fraction digits of a price. */
export const PRICE_DIGITS = 12;

/**
 * Effective price in SOL per whole token: `lamports / 10^9` divided by
 * `units / 10^decimals`, rounded down to `digits` places, decimal comma, no trailing
 * zeros. Null without tokens.
 */
export function formatPrice(
  lamports: bigint,
  units: bigint,
  decimals: number,
  digits = PRICE_DIGITS,
): string | null {
  if (units <= 0n || lamports < 0n) return null;
  const scale = 10n ** BigInt(digits);
  const scaled = (lamports * 10n ** BigInt(decimals) * scale) / (units * 10n ** LAMPORTS_DECIMALS);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()},${fraction}`;
}

export interface LogContext {
  /** Public address of a wallet index. */
  readonly addressOf: (index: number) => string | null;
  /** Decimals of the bought token, when known (for the price). */
  readonly decimals: number | null;
}

const EMPTY = {
  wallet: null,
  address: null,
  reason: null,
  detail: null,
  message: null,
  attempt: null,
  quoteIn: null,
  quoteOut: null,
  router: null,
  signature: null,
  slot: null,
  spent: null,
  received: null,
  price: null,
  orderMs: null,
  signMs: null,
  executeMs: null,
  expected: null,
  observed: null,
  mint: null,
  source: null,
  path: null,
  reactionMs: null,
} as const;

const DISARMED_MESSAGE = 'Rozbrojono watcher, zanim ten token doczekał się zakupu.';
const STALE_MESSAGE = 'Transakcja sprzed uzbrojenia: to nie jest nowy token, więc nie ma zakupu.';
const MISMATCH_MESSAGE =
  'Transakcja nie tworzy mintu wykrytego z logu. Zakup już ruszył: sprawdź token.';

function problemMessage(problem: DetectionProblem): string {
  if (problem === 'DISARMED') return DISARMED_MESSAGE;
  if (problem === 'STALE') return STALE_MESSAGE;
  return ERROR_MESSAGES[problem];
}

function watchEntry(event: WatchEvent, time: string): LogEntry {
  const base = { ...EMPTY, time, runId: null, event: 'watch' as const, state: event.type };
  switch (event.type) {
    case 'armed':
      return { ...base, address: event.creator, detail: event.mode };
    case 'disarmed':
      return { ...base, detail: event.reason };
    case 'connection':
      return { ...base, detail: event.status, attempt: event.attempt };
    case 'queued':
    case 'stale':
    case 'detection': {
      const d = event.detection;
      return {
        ...base,
        runId: d.runId,
        reason: d.problem,
        message: d.problem === null ? null : problemMessage(d.problem),
        signature: d.signature,
        mint: d.mint,
        source: d.source,
        path: d.path,
        reactionMs: d.reactionMs,
      };
    }
    case 'verified':
      return {
        ...base,
        detail: event.match ? 'match' : 'mismatch',
        message: event.match ? null : MISMATCH_MESSAGE,
        signature: event.signature,
        mint: event.mint,
      };
  }
}

export function logEntry(event: LoggedEvent, context: LogContext): LogEntry {
  const time = new Date(event.at).toISOString();
  switch (event.kind) {
    case 'watch':
      return watchEntry(event, time);
    case 'run':
      return { ...EMPTY, time, runId: event.runId, event: 'run', state: event.phase };
    case 'verify':
      return {
        ...EMPTY,
        time,
        runId: event.runId,
        event: 'verify',
        state: event.status,
        wallet: event.index,
        address: context.addressOf(event.index),
        message: VERIFY_MESSAGES[event.status],
        expected: event.expected,
        observed: event.observed,
      };
    case 'wallet': {
      const { reason, quote, result, times } = event;
      const message =
        reason === null
          ? null
          : reason.kind === 'SKIPPED'
            ? SKIP_MESSAGES[reason.code]
            : reason.kind === 'FAILED'
              ? FAIL_MESSAGES[reason.code]
              : UNKNOWN_MESSAGES[reason.code];
      const spent = result?.totalInputAmount ?? null;
      const received = result?.totalOutputAmount ?? null;
      return {
        ...EMPTY,
        time,
        runId: event.runId,
        event: 'wallet',
        state: event.state,
        wallet: event.index,
        address: context.addressOf(event.index),
        reason: reason?.code ?? null,
        detail: reason?.detail ?? null,
        message,
        attempt: event.attempt,
        quoteIn: quote?.inAmount ?? null,
        quoteOut: quote?.outAmount ?? null,
        router: quote?.router ?? null,
        signature: result?.signature ?? null,
        slot: result?.slot ?? null,
        spent,
        received,
        price:
          spent !== null && received !== null && context.decimals !== null
            ? formatPrice(spent, received, context.decimals)
            : null,
        orderMs: times.orderMs,
        signMs: times.signMs,
        executeMs: times.executeMs,
      };
    }
  }
}

/** A spreadsheet runs a cell starting with these as a formula (OWASP "CSV injection"). */
const FORMULA_START = /^[=+\-@\t\r]/u;

export function csvCell(value: string | number | bigint | null): string {
  if (value === null) return '';
  let text = value.toString();
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n;]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV with a header row and CRLF line ends. */
export function toCsv(entries: readonly LogEntry[]): string {
  const lines = [LOG_COLUMNS.join(',')];
  for (const entry of entries) lines.push(LOG_COLUMNS.map((c) => csvCell(entry[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** JSON array; bigint amounts as decimal strings, so no precision is lost. */
export function toJson(entries: readonly LogEntry[]): string {
  return JSON.stringify(
    entries,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

/** `bunndly-log-<run>-<UTC time>.csv` (no characters that file systems refuse). */
export function logFileName(runId: number, at: number, format: 'csv' | 'json'): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/gu, '-');
  return `bunndly-log-${String(runId)}-${stamp}.${format}`;
}
