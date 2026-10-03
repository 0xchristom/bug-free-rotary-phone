/**
 * What the executor does after each step (BUNNDLY-21 and 23, D-029, D-030). Kept apart
 * from the pipeline so the queue logic does not know Jupiter's codes.
 *
 * The rule that keeps a wallet from buying twice: after `/execute` was called, a wallet
 * goes back to the queue only when Jupiter said for sure that nothing was sent (`requeue`)
 * or after the chain showed that the transaction did not land and can no longer land
 * (`check`). Everything that could have been sent goes through `check`.
 */
import type {
  JupiterExecution,
  JupiterFailure,
  JupiterFailureCode,
  OrderBuildReason,
} from '../jupiter/client.ts';
import type { FailReason, SkipReason } from './states.ts';

export type Decision =
  /** Back to the end of the queue; `countAttempt` uses one of `maxAttempts`. */
  | { readonly action: 'requeue'; readonly countAttempt: boolean; readonly detail: string }
  | { readonly action: 'fail'; readonly reason: FailReason; readonly detail: string | null }
  | { readonly action: 'skip'; readonly reason: SkipReason; readonly detail: string | null }
  /** No route yet (400 "no route" or 500): the mint gate, inside its window, no attempts. */
  | { readonly action: 'noRoute'; readonly detail: string }
  /**
   * It may have been sent: check the chain. Landed → CONFIRMED; landed with an error or
   * expired without landing → back to the queue (counts); unresolved → UNKNOWN for good.
   */
  | { readonly action: 'check'; readonly detail: string };

const RETRY_ORDER: ReadonlySet<JupiterFailureCode> = new Set(['TIMEOUT', 'NETWORK']);

/**
 * "No route yet" (D-035): for a fresh mint Jupiter first answers HTTP 500, then 400
 * "Failed to get quotes", then a route. Both go to the run's mint gate, without attempts.
 */
const NO_ROUTE_YET: ReadonlySet<JupiterFailureCode> = new Set(['NO_ROUTE', 'SERVER_ERROR']);

/** `/order` gave no usable answer. Nothing was sent, so a retry is always safe. */
export function afterOrderFailure(failure: JupiterFailure): Decision {
  // The limiter already paused for the window; this attempt does not count.
  if (failure.code === 'RATE_LIMITED') {
    return { action: 'requeue', countAttempt: false, detail: failure.code };
  }
  if (NO_ROUTE_YET.has(failure.code)) return { action: 'noRoute', detail: failure.code };
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

/** Our own mistakes: the same request would fail again, and nothing was sent. */
export const EXECUTE_FATAL: ReadonlySet<number> = new Set([-2, -3, -1002, -1003, -2002]);
/**
 * Jupiter refused before sending: missing cached order, wrong block height, expired RFQ
 * quote, swap rejected by the market maker. A new `/order` is safe.
 */
export const EXECUTE_NOT_SENT: ReadonlySet<number> = new Set([-1, -1004, -2003, -2004]);

/** `/execute` answered (success or a failure with a code). */
export function afterExecution(
  execution: JupiterExecution,
): Decision | { readonly action: 'confirm' } {
  if (execution.status === 'Success') return { action: 'confirm' };
  if (EXECUTE_FATAL.has(execution.code)) {
    return { action: 'fail', reason: 'EXECUTE_FAILED', detail: execution.outcome };
  }
  if (EXECUTE_NOT_SENT.has(execution.code)) {
    return { action: 'requeue', countAttempt: true, detail: execution.outcome };
  }
  // Failed to land (-1000, -2000), unknown (-1001, -2001), failed after landing (e.g.
  // slippage) and undocumented codes: the transaction may be on the chain.
  return { action: 'check', detail: execution.outcome };
}

/** `/execute` gave no usable answer. */
export function afterExecuteFailure(failure: JupiterFailure): Decision {
  // Rejected at the gate: the request never reached execution.
  if (failure.code === 'RATE_LIMITED') {
    return { action: 'requeue', countAttempt: false, detail: failure.code };
  }
  if (
    failure.code === 'UNAUTHORIZED' ||
    failure.code === 'FORBIDDEN' ||
    failure.code === 'BAD_REQUEST'
  ) {
    return { action: 'fail', reason: 'EXECUTE_FAILED', detail: failure.code };
  }
  // No answer, 5xx, odd answer: it may have been sent.
  return { action: 'check', detail: failure.code };
}
