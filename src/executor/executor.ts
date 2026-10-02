/**
 * Executor (SPEC 3.5, BUNNDLY-21, D-029): every active wallet buys, wallets never block
 * each other, nobody buys twice.
 *
 * - A FIFO queue of wallets. A dispatcher takes the next wallet as soon as the `/order`
 *   limiter grants a slot and starts its attempt without waiting for others.
 * - An attempt is a pipeline: `/order` → checks and signature (vault) → `/execute`. A
 *   wallet with a fast `/order` executes while others still wait for theirs; `/execute`
 *   calls of different wallets run in parallel. A wallet is in at most one attempt.
 * - DRY-RUN runs real `/order`, checks and signing, then throws the signed transaction
 *   away: `/execute` is never called, on any path.
 *
 * Pure logic with injected Jupiter client, signer, limiters and clock; no DOM, no keys.
 * Events carry no keys and no signed transactions.
 */
import type { JupiterClient, JupiterExecution, JupiterOrder } from '../jupiter/client.ts';
import type { ExecuteLimiter, LimiterClock, OrderLimiter } from './limiter.ts';
import {
  afterBuildError,
  afterExecuteFailure,
  afterExecution,
  afterOrderFailure,
  type Decision,
} from './policy.ts';
import {
  FINAL_STATES,
  WALLET_STATES,
  assertTransition,
  type FailReason,
  type SkipReason,
  type UnknownReason,
  type WalletReason,
  type WalletState,
} from './states.ts';

export interface ExecutorWallet {
  readonly index: number;
  readonly address: string;
  /** Lamports to spend; every order asks for exactly this. */
  readonly maxSpend: bigint;
  /** Last read SOL balance, null when never read. */
  readonly balance: bigint | null;
}

/** The vault's signer (BUNNDLY-22): checks, then signs. Never throws. */
export type OrderSigner = (
  walletIndex: number,
  request: { readonly outputMint: string; readonly amount: bigint },
  order: JupiterOrder,
) => Promise<
  | { readonly ok: true; readonly signedTransaction: string; readonly signature: string | null }
  | { readonly ok: false; readonly problem: string }
>;

export interface WalletQuote {
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  readonly router: string;
}

export interface WalletResult {
  /** Transaction signature: from `/execute`, or known before it when the taker pays. */
  readonly signature: string | null;
  readonly slot: bigint | null;
  readonly totalInputAmount: bigint | null;
  readonly totalOutputAmount: bigint | null;
}

export interface WalletTimes {
  /** Duration of the last `/order` call. */
  readonly orderMs: number | null;
  /** Checks and signature in the vault. */
  readonly signMs: number | null;
  /** Duration of `/execute`. */
  readonly executeMs: number | null;
  /** Since the run started. */
  readonly sinceStartMs: number;
}

export interface WalletEvent {
  readonly kind: 'wallet';
  readonly runId: number;
  readonly index: number;
  readonly state: WalletState;
  /** Attempts used so far (`/order` calls that counted). */
  readonly attempt: number;
  readonly reason: WalletReason | null;
  readonly quote: WalletQuote | null;
  readonly result: WalletResult | null;
  readonly times: WalletTimes;
}

export type RunPhase = 'started' | 'stopping' | 'finished';

export interface RunEvent {
  readonly kind: 'run';
  readonly runId: number;
  readonly phase: RunPhase;
  readonly mint: string;
  readonly dryRun: boolean;
  readonly wallets: number;
  readonly counts: Readonly<Record<WalletState, number>>;
}

export type ExecutorEvent = WalletEvent | RunEvent;

export interface ExecutorDeps {
  readonly jupiter: JupiterClient;
  readonly orderLimiter: OrderLimiter;
  readonly executeLimiter: ExecuteLimiter;
  readonly sign: OrderSigner;
  readonly clock: LimiterClock;
  readonly emit: (event: ExecutorEvent) => void;
}

export interface RunOptions {
  readonly runId: number;
  readonly mint: string;
  readonly wallets: readonly ExecutorWallet[];
  readonly dryRun: boolean;
  readonly maxAttempts: number;
  readonly minReserveLamports: bigint;
}

export interface WalletSnapshot {
  readonly index: number;
  readonly state: WalletState;
  readonly attempt: number;
  readonly reason: WalletReason | null;
}

export interface RunSummary {
  readonly runId: number;
  readonly counts: Readonly<Record<WalletState, number>>;
  readonly wallets: readonly WalletSnapshot[];
}

export interface ExecutorRun {
  /** Resolves when every wallet is in a final state; rejects only on a programming error. */
  readonly done: Promise<RunSummary>;
  /** STOP: empties the queue, starts no new `/order`; sent transactions finish. */
  stop(): void;
  snapshot(): RunSummary;
}

interface Slot {
  readonly wallet: ExecutorWallet;
  state: WalletState;
  attempt: number;
  reason: WalletReason | null;
  quote: WalletQuote | null;
  result: WalletResult | null;
  orderMs: number | null;
  signMs: number | null;
  executeMs: number | null;
}

function emptyCounts(): Record<WalletState, number> {
  return Object.fromEntries(WALLET_STATES.map((s) => [s, 0])) as Record<WalletState, number>;
}

export function startRun(deps: ExecutorDeps, options: RunOptions): ExecutorRun {
  const { clock, jupiter } = deps;
  const startedAt = clock.now();
  const slots = new Map<number, Slot>(
    options.wallets.map((wallet) => [
      wallet.index,
      {
        wallet,
        state: 'IDLE',
        attempt: 0,
        reason: null,
        quote: null,
        result: null,
        orderMs: null,
        signMs: null,
        executeMs: null,
      },
    ]),
  );
  const queue: number[] = [];
  const stopSignal = new AbortController();
  let stopped = false;
  /** Read through a function: STOP flips it while the dispatcher awaits. */
  const isStopped = (): boolean => stopped;
  let inFlight = 0;
  let fatal: unknown = null;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  const idle = (): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
    });

  const slotOf = (index: number): Slot => {
    const slot = slots.get(index);
    if (!slot) throw new Error(`no wallet ${String(index)}`);
    return slot;
  };

  const counts = (): Record<WalletState, number> => {
    const c = emptyCounts();
    for (const s of slots.values()) c[s.state] += 1;
    return c;
  };

  const summary = (): RunSummary => ({
    runId: options.runId,
    counts: counts(),
    wallets: [...slots.values()].map((s) => ({
      index: s.wallet.index,
      state: s.state,
      attempt: s.attempt,
      reason: s.reason,
    })),
  });

  const emitRun = (phase: RunPhase): void => {
    deps.emit({
      kind: 'run',
      runId: options.runId,
      phase,
      mint: options.mint,
      dryRun: options.dryRun,
      wallets: slots.size,
      counts: counts(),
    });
  };

  const move = (index: number, to: WalletState, reason: WalletReason | null = null): void => {
    const slot = slotOf(index);
    assertTransition(slot.state, to);
    slot.state = to;
    if (reason !== null || FINAL_STATES.has(to)) slot.reason = reason;
    deps.emit({
      kind: 'wallet',
      runId: options.runId,
      index,
      state: to,
      attempt: slot.attempt,
      reason: slot.reason,
      quote: slot.quote,
      result: slot.result,
      times: {
        orderMs: slot.orderMs,
        signMs: slot.signMs,
        executeMs: slot.executeMs,
        sinceStartMs: clock.now() - startedAt,
      },
    });
  };

  const skip = (index: number, code: SkipReason, detail: string | null = null): void => {
    move(index, 'SKIPPED', { kind: 'SKIPPED', code, detail });
  };
  const fail = (index: number, code: FailReason, detail: string | null): void => {
    move(index, 'FAILED', { kind: 'FAILED', code, detail });
  };
  const unknown = (index: number, code: UnknownReason, detail: string | null): void => {
    move(index, 'UNKNOWN', { kind: 'UNKNOWN', code, detail });
  };

  /** Back to the end of the queue, or done when attempts are used up or STOP came. */
  const requeue = (index: number, countAttempt: boolean, detail: string): void => {
    const slot = slotOf(index);
    if (countAttempt && slot.attempt >= options.maxAttempts) {
      fail(index, 'MAX_ATTEMPTS', detail);
      return;
    }
    move(index, 'QUEUED');
    if (!countAttempt) slot.attempt -= 1; // this attempt did not count
    if (stopped) {
      skip(index, 'STOPPED');
      return;
    }
    queue.push(index);
    nudge();
  };

  const apply = (index: number, decision: Decision): void => {
    switch (decision.action) {
      case 'requeue':
        requeue(index, decision.countAttempt, decision.detail);
        return;
      case 'fail':
        fail(index, decision.reason, decision.detail);
        return;
      case 'skip':
        skip(index, decision.reason, decision.detail);
        return;
      case 'unknown':
        unknown(index, decision.reason, decision.detail);
        return;
    }
  };

  const confirm = (index: number, execution: JupiterExecution, signature: string | null): void => {
    const slot = slotOf(index);
    slot.result = {
      signature: execution.signature ?? signature,
      slot: execution.slot,
      totalInputAmount: execution.totalInputAmount,
      totalOutputAmount: execution.totalOutputAmount,
    };
    move(index, 'CONFIRMED');
  };

  /** One attempt of one wallet: /order → sign → /execute. Never throws on data. */
  const attempt = async (index: number): Promise<void> => {
    const slot = slotOf(index);
    const { wallet } = slot;
    slot.attempt += 1;
    move(index, 'QUOTING');

    const orderStart = clock.now();
    const ordered = await jupiter.getOrder({
      outputMint: options.mint,
      amount: wallet.maxSpend,
      taker: wallet.address,
    });
    slot.orderMs = clock.now() - orderStart;
    deps.orderLimiter.report({
      httpStatus: ordered.ok ? 200 : ordered.httpStatus,
      rateLimit: ordered.rateLimit,
    });
    if (!ordered.ok) {
      apply(index, afterOrderFailure(ordered));
      return;
    }
    const order = ordered.value;
    slot.quote = { inAmount: order.inAmount, outAmount: order.outAmount, router: order.router };
    if (order.buildError !== null) {
      apply(index, afterBuildError(order.buildError.reason));
      return;
    }

    move(index, 'SIGNING');
    const signStart = clock.now();
    const signed = await deps.sign(
      index,
      { outputMint: options.mint, amount: wallet.maxSpend },
      order,
    );
    slot.signMs = clock.now() - signStart;
    if (!signed.ok) {
      fail(index, 'CHECK_FAILED', signed.problem);
      return;
    }
    if (options.dryRun) {
      // The signed transaction is dropped here; /execute is never called in DRY-RUN.
      skip(index, 'DRY_RUN');
      return;
    }
    if (stopped || !(await deps.executeLimiter.acquire(stopSignal.signal))) {
      skip(index, 'STOPPED');
      return;
    }

    move(index, 'SUBMITTED');
    if (signed.signature !== null) {
      slot.result = {
        signature: signed.signature,
        slot: null,
        totalInputAmount: null,
        totalOutputAmount: null,
      };
    }
    const executeStart = clock.now();
    const executed = await jupiter.execute({
      signedTransaction: signed.signedTransaction,
      requestId: order.requestId,
      ...(order.lastValidBlockHeight === null
        ? {}
        : { lastValidBlockHeight: order.lastValidBlockHeight }),
    });
    slot.executeMs = clock.now() - executeStart;
    if (!executed.ok) {
      if (executed.signature !== null) {
        slot.result = {
          signature: executed.signature,
          slot: null,
          totalInputAmount: null,
          totalOutputAmount: null,
        };
      }
      apply(index, afterExecuteFailure(executed));
      return;
    }
    const decision = afterExecution(executed.value);
    if (decision.action === 'confirm') {
      confirm(index, executed.value, signed.signature);
      return;
    }
    if (executed.value.signature !== null) {
      slot.result = {
        signature: executed.value.signature,
        slot: executed.value.slot,
        totalInputAmount: executed.value.totalInputAmount,
        totalOutputAmount: executed.value.totalOutputAmount,
      };
    }
    apply(index, decision);
  };

  const dispatch = async (): Promise<RunSummary> => {
    emitRun('started');
    // Before /order: balances from the last refresh only, no requests on the hot path.
    for (const slot of slots.values()) {
      const { wallet } = slot;
      if (wallet.balance === null) {
        skip(wallet.index, 'BALANCE_UNKNOWN');
      } else if (wallet.balance < wallet.maxSpend + options.minReserveLamports) {
        skip(wallet.index, 'INSUFFICIENT_SOL');
      } else {
        move(wallet.index, 'QUEUED');
        queue.push(wallet.index);
      }
    }

    while (fatal === null && !stopped) {
      const index = queue.shift();
      if (index === undefined) {
        if (inFlight === 0) break;
        await idle();
        continue;
      }
      if (!(await deps.orderLimiter.acquire(stopSignal.signal))) {
        queue.unshift(index);
        break;
      }
      if (isStopped()) {
        queue.unshift(index);
        break;
      }
      inFlight += 1;
      void attempt(index)
        .catch((e: unknown) => {
          fatal ??= e;
        })
        .finally(() => {
          inFlight -= 1;
          nudge();
        });
    }
    // STOP: the queue empties; attempts in flight finish on their own.
    for (const index of queue.splice(0)) skip(index, 'STOPPED');
    while (inFlight > 0) await idle();
    if (fatal !== null) throw fatal instanceof Error ? fatal : new Error('executor failure');
    emitRun('finished');
    return summary();
  };

  const done = dispatch();
  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      stopSignal.abort();
      emitRun('stopping');
      nudge();
    },
    snapshot: summary,
  };
}
