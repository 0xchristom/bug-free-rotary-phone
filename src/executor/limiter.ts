/**
 * Rate limiters for Jupiter (SPEC 3.5, BUNNDLY-20, D-027). Pure logic with an injected
 * clock, no DOM: runs in the worker and in Node tests.
 *
 * `/order`: a budget of 90% of the plan's per-minute limit (Krystian's decision of
 * 2026-10-02). The whole budget may go out at once at the start; after that no sliding
 * 60 s window holds more starts than the budget. Rate limit headers only correct this:
 * `remaining ≤ 0` or a 429 pauses new calls until `x-ratelimit-reset`, or for a backoff of
 * 1 s → 2 s → 4 s … (max 10 s) when the header is missing.
 *
 * `/execute`: its own pool (rate-limits.md "Buckets"), 90% of it per second, never
 * touching the `/order` budget.
 */
import type { RateLimitHeaders } from '../core/connection.ts';
import { JUPITER_PLAN_RPM, type JupiterPlan } from '../core/settings.ts';

export interface LimiterClock {
  /** Milliseconds, the same scale as `Date.now()` (headers give Unix seconds). */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Share of a plan limit we use (Krystian, 2026-10-02). */
export const LIMIT_SHARE = 0.9;
export const ORDER_WINDOW_MS = 60_000;
export const EXECUTE_WINDOW_MS = 1_000;
export const BACKOFF_START_MS = 1_000;
export const BACKOFF_MAX_MS = 10_000;
/** A reset further away than this is not trusted (clock skew, a bad header). */
export const MAX_PAUSE_MS = 60_000;

/** `/order` budget per 60 s window: 90% of the plan limit, at least 1. */
export function orderBudget(orderRpm: number): number {
  return Math.max(1, Math.floor((orderRpm * 9) / 10));
}

/** `/execute` pools per second (rate-limits.md "Buckets"). */
export const EXECUTE_POOL_RPS = { keyless: 20, free: 50, paid: 100 } as const;

/**
 * `/execute` budget per second for a plan. A custom plan is placed by its `/order`
 * limit: up to Keyless gives the Keyless pool, up to Free the Free pool, above that paid.
 */
export function executeBudget(plan: JupiterPlan, orderRpm: number): number {
  let pool: number;
  if (plan === 'keyless') pool = EXECUTE_POOL_RPS.keyless;
  else if (plan === 'free') pool = EXECUTE_POOL_RPS.free;
  else if (plan !== 'custom') pool = EXECUTE_POOL_RPS.paid;
  else if (orderRpm <= JUPITER_PLAN_RPM.keyless) pool = EXECUTE_POOL_RPS.keyless;
  else if (orderRpm <= JUPITER_PLAN_RPM.free) pool = EXECUTE_POOL_RPS.free;
  else pool = EXECUTE_POOL_RPS.paid;
  return Math.max(1, Math.floor((pool * 9) / 10));
}

export interface WindowLimiterOptions {
  /** Most starts in any sliding window. */
  readonly budget: number;
  readonly windowMs: number;
  readonly clock?: LimiterClock;
  /**
   * Even pace (emergency mode): one start every windowMs / budget instead of a burst.
   * For use if bursts turn out to cause 429 (BUNNDLY-30).
   */
  readonly steady?: boolean;
}

interface Waiter {
  readonly resolve: (granted: boolean) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * Sliding-window limiter: FIFO waiters, each granted a start when the window (and any
 * pause) allows it.
 */
export class WindowLimiter {
  readonly budget: number;
  private readonly windowMs: number;
  private readonly clock: LimiterClock;
  private readonly steady: boolean;
  /** Start times inside the current window, oldest first. */
  private readonly starts: number[] = [];
  private readonly waiters: Waiter[] = [];
  private pausedUntil = 0;
  private pumping = false;

  constructor(options: WindowLimiterOptions) {
    this.budget = Math.max(1, Math.floor(options.budget));
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? realClock;
    this.steady = options.steady ?? false;
  }

  /**
   * Waits for a start slot. Resolves true when the call may start now, false when the
   * signal aborted first (e.g. STOP). Never rejects.
   */
  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        onAbort: () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        },
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      void this.pump();
    });
  }

  /** No new start before `until` (ms). A later pause wins over an earlier one. */
  pauseUntil(until: number): void {
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  /** For tests and the UI: starts in the current window and the pause end. */
  snapshot(): {
    readonly inWindow: number;
    readonly pausedUntil: number;
    readonly waiting: number;
  } {
    this.prune(this.clock.now());
    return {
      inWindow: this.starts.length,
      pausedUntil: this.pausedUntil,
      waiting: this.waiters.length,
    };
  }

  private prune(now: number): void {
    while (this.starts.length > 0 && (this.starts[0] ?? 0) <= now - this.windowMs)
      this.starts.shift();
  }

  /** Earliest time the next start is allowed. */
  private nextAllowed(now: number): number {
    this.prune(now);
    let at = Math.max(now, this.pausedUntil);
    if (this.starts.length >= this.budget) {
      const oldest = this.starts[this.starts.length - this.budget] ?? now;
      at = Math.max(at, oldest + this.windowMs);
    }
    if (this.steady) {
      const last = this.starts.at(-1);
      if (last !== undefined) at = Math.max(at, last + this.windowMs / this.budget);
    }
    return at;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiters.length > 0) {
        const now = this.clock.now();
        const at = this.nextAllowed(now);
        if (at > now) {
          await this.clock.sleep(at - now);
          continue; // the pause may have grown meanwhile; check again
        }
        const waiter = this.waiters.shift();
        if (waiter === undefined) break;
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        this.starts.push(now);
        waiter.resolve(true);
      }
    } finally {
      this.pumping = false;
    }
  }
}

/** What a finished `/order` call tells the limiter. */
export interface OrderFeedback {
  /** HTTP status, or null when no answer came (timeout, network). */
  readonly httpStatus: number | null;
  readonly rateLimit: RateLimitHeaders | null;
}

export interface OrderLimiterOptions {
  readonly orderRpm: number;
  readonly clock?: LimiterClock;
  readonly steady?: boolean;
}

/** `/order` limiter: window budget plus the correction from headers and 429. */
export class OrderLimiter {
  private readonly window: WindowLimiter;
  private readonly clock: LimiterClock;
  /** 429s or empty windows in a row without a reset header (for the backoff). */
  private strikes = 0;

  constructor(options: OrderLimiterOptions) {
    this.clock = options.clock ?? realClock;
    this.window = new WindowLimiter({
      budget: orderBudget(options.orderRpm),
      windowMs: ORDER_WINDOW_MS,
      clock: this.clock,
      ...(options.steady === undefined ? {} : { steady: options.steady }),
    });
  }

  get budget(): number {
    return this.window.budget;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    return this.window.acquire(signal);
  }

  snapshot() {
    return this.window.snapshot();
  }

  /** Feeds the answer of a finished call. Missing headers never change the budget. */
  report(feedback: OrderFeedback): void {
    const limited = feedback.httpStatus === 429;
    const remaining = feedback.rateLimit?.remaining ?? null;
    const exhausted = remaining !== null && remaining <= 0;
    if (!limited && !exhausted) {
      if (feedback.httpStatus !== null && feedback.httpStatus < 400) this.strikes = 0;
      return;
    }
    const now = this.clock.now();
    const reset = feedback.rateLimit?.reset ?? null;
    const untilReset = reset === null ? 0 : reset * 1000 - now;
    if (untilReset > 0) {
      this.strikes = 0;
      this.window.pauseUntil(now + Math.min(untilReset, MAX_PAUSE_MS));
      return;
    }
    // No usable reset: back off 1 s, 2 s, 4 s … up to 10 s.
    const delay = Math.min(BACKOFF_START_MS * 2 ** this.strikes, BACKOFF_MAX_MS);
    this.strikes += 1;
    this.window.pauseUntil(now + delay);
  }
}

/** `/execute` limiter: its own per-second pool, independent of the `/order` budget. */
export class ExecuteLimiter {
  private readonly window: WindowLimiter;

  constructor(options: {
    readonly plan: JupiterPlan;
    readonly orderRpm: number;
    readonly clock?: LimiterClock;
  }) {
    this.window = new WindowLimiter({
      budget: executeBudget(options.plan, options.orderRpm),
      windowMs: EXECUTE_WINDOW_MS,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  }

  get budget(): number {
    return this.window.budget;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    return this.window.acquire(signal);
  }

  snapshot() {
    return this.window.snapshot();
  }
}
