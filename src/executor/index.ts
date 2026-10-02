// Queue, limiter, pipeline, retry, idempotency (SPEC 4).
export {
  BACKOFF_MAX_MS,
  BACKOFF_START_MS,
  EXECUTE_POOL_RPS,
  EXECUTE_WINDOW_MS,
  ExecuteLimiter,
  LIMIT_SHARE,
  MAX_PAUSE_MS,
  ORDER_WINDOW_MS,
  OrderLimiter,
  WindowLimiter,
  executeBudget,
  orderBudget,
  realClock,
} from './limiter.ts';
export type {
  LimiterClock,
  OrderFeedback,
  OrderLimiterOptions,
  WindowLimiterOptions,
} from './limiter.ts';
export { MAX_ORDER_SIGNERS, ORDER_CHECK_MESSAGES, checkOrderTransaction } from './order-check.ts';
export type {
  CheckedOrder,
  OrderCheckProblem,
  OrderCheckResult,
  OrderExpectation,
} from './order-check.ts';
export {
  FAIL_MESSAGES,
  FINAL_STATES,
  IllegalTransitionError,
  SKIP_MESSAGES,
  TRANSITIONS,
  UNKNOWN_MESSAGES,
  WALLET_STATES,
  assertTransition,
} from './states.ts';
export type { FailReason, SkipReason, UnknownReason, WalletReason, WalletState } from './states.ts';
export { startRun } from './executor.ts';
export type {
  ExecutorDeps,
  ExecutorEvent,
  ExecutorRun,
  ExecutorWallet,
  OrderSigner,
  RunEvent,
  RunOptions,
  RunPhase,
  RunSummary,
  WalletEvent,
  WalletQuote,
  WalletResult,
  WalletSnapshot,
  WalletTimes,
} from './executor.ts';
export {
  afterBuildError,
  afterExecuteFailure,
  afterExecution,
  afterOrderFailure,
} from './policy.ts';
export type { Decision } from './policy.ts';
