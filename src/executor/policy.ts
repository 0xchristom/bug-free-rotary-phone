/**
 * What the executor does after each step (BUNNDLY-21, D-029). Kept apart from the
 * pipeline so BUNNDLY-23 can refine it (chain check before any retry, "no route" window,
 * price ceiling) without touching the queue logic.
 *
 * Provisional rule until BUNNDLY-23: no answer from `/execute` and its "unknown error"
 * codes end in UNKNOWN and are never retried here. A documented failure that Jupiter
 * reports after its own confirmation polling (failed to land, slippage after landing)
 * goes back to the queue; BUNNDLY-23 adds the chain check before such a retry, so live
 * mode is not used before it (DRY-RUN is the default).
 */
import type {
  JupiterExecution,
  JupiterFailure,
  JupiterFailureCode,
  OrderBuildReason,
} from '../jupiter/client.ts';
import type { FailReason, SkipReason, UnknownReason } from './states.ts';

export type Decision =
  /** Back to the end of the queue; `countAttempt` uses one of `maxAttempts`. */
  | { readonly action: 'requeue'; readonly countAttempt: boolean; readonly detail: string }
  | { readonly action: 'fail'; readonly reason: FailReason; readonly detail: string | null }
  | { readonly action: 'skip'; readonly reason: SkipReason; readonly detail: string | null }
  | { readonly action: 'unknown'; readonly reason: UnknownReason; readonly detail: string };

const RETRY_ORDER: ReadonlySet<JupiterFailureCode> = new Set([
  'SERVER_ERROR',
  'TIMEOUT',
  'NETWORK',
  'NO_ROUTE',
]);

/** `/order` gave no usable answer. Nothing was sent, so a retry is always safe. */
export function afterOrderFailure(failure: JupiterFailure): Decision {
  // The limiter already paused for the window; this attempt does not count.
  if (failure.code === 'RATE_LIMITED') {
    return { action: 'requeue', countAttempt: false, detail: failure.code };
  }
  if (RETRY_ORDER.has(failure.code)) {
    return { action: 'requeue', countAttempt: true, detail: failure.code };
  }
  return { action: 'fail', reason: 'ORDER_FAILED', detail: failure.code };
}

/** `/order` quoted a price but built no transaction (`transaction: ""`). */
export function afterBuildError(reason: OrderBuildReason): Decision {
  if (reason === 'INSUFFICIENT_FUNDS') return { action: 'skip', reason, detail: null };
  if (reason === 'INSUFFICIENT_SOL_FOR_GAS') return { action: 'skip', reason, detail: null };
  return { action: 'requeue', countAttempt: true, detail: reason };
}

/** Our own mistakes: the same transaction would fail again. */
const EXECUTE_FATAL = new Set([-2, -3, -1002, -1003, -2002]);
/** Jupiter could not tell whether it landed. */
const EXECUTE_UNKNOWN = new Set([-1001, -2001]);

/** `/execute` answered (success or a documented failure). */
export function afterExecution(
  execution: JupiterExecution,
): Decision | { readonly action: 'confirm' } {
  if (execution.status === 'Success') return { action: 'confirm' };
  if (EXECUTE_FATAL.has(execution.code)) {
    return { action: 'fail', reason: 'EXECUTE_FAILED', detail: execution.outcome };
  }
  if (EXECUTE_UNKNOWN.has(execution.code)) {
    return { action: 'unknown', reason: 'EXECUTE_NO_ANSWER', detail: execution.outcome };
  }
  // Expired order or quote, rejected swap, failed to land, failed after landing
  // (e.g. slippage), undocumented codes: transient, back to the queue.
  return { action: 'requeue', countAttempt: true, detail: execution.outcome };
}

/** `/execute` gave no usable answer. */
export function afterExecuteFailure(failure: JupiterFailure): Decision {
  // Rejected at the gate: the request never reached execution.
  if (failure.code === 'RATE_LIMITED') {
    return { action: 'requeue', countAttempt: false, detail: failure.code };
  }
  if (failure.code === 'UNAUTHORIZED' || failure.code === 'FORBIDDEN') {
    return { action: 'fail', reason: 'EXECUTE_FAILED', detail: failure.code };
  }
  if (failure.code === 'BAD_REQUEST') {
    return { action: 'fail', reason: 'EXECUTE_FAILED', detail: failure.code };
  }
  // No answer, 5xx, odd answer: it may have been sent.
  return { action: 'unknown', reason: 'EXECUTE_NO_ANSWER', detail: failure.code };
}
