/**
 * Executor (SPEC 3.5, BUNNDLY-21 and 23, D-029, D-030): every active wallet buys, wallets
 * never block each other, nobody buys twice.
 *
 * - A FIFO queue of wallets. A dispatcher takes the next wallet as soon as the `/order`
 *   limiter grants a slot and starts its attempt without waiting for others.
 * - An attempt is a pipeline: `/order` → checks and signature (vault) → `/execute`. A
 *   wallet with a fast `/order` executes while others still wait for theirs; `/execute`
 *   calls of different wallets run in parallel. A wallet is in at most one attempt.
 * - DRY-RUN runs real `/order`, checks and signing, then throws the signed transaction
 *   away: `/execute` is never called, on any path.
 * - Idempotency: after `/execute` a wallet is retried only when Jupiter said nothing was
 *   sent, or after the chain showed the transaction did not land and can no longer land.
 *   Until then the wallet is UNKNOWN and checked every 2 s (`landing.ts`).
 * - Mint gate (D-035): the run starts with one probe `/order`; "no route" or HTTP 500
 *   closes the gate again later. While closed, one probe at a time (with backoff after
 *   "no route") and everyone else waits in the queue without requests; a route opens it.
 *   The window counts from the first "no route" of the run, and once the gate has opened,
 *   from each re-close; when it ends, the waiting wallets fail without further requests.
 * - Price ceiling: after the first fill, a quote above it by more than the ceiling skips.
 *
 * Pure logic with injected Jupiter client, signer, limiters and clock; no DOM, no keys.
 * Events carry no keys and no signed transactions.
 */
import type { JupiterClient, JupiterExecution, JupiterOrder } from '../jupiter/client.ts';
import type { VerifyEvent } from './verify.ts';
import {
  LANDING_POLL_MS,
  LANDING_TIMEOUT_MS,
  type Landing,
  type LandingChecker,
  type LandingQuery,
} from './landing.ts';
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
  /** Since the run started, or since the detection in mode B (`triggeredAt`). */
  readonly sinceStartMs: number;
}

export interface WalletEvent {
  readonly kind: 'wallet';
  readonly runId: number;
  /** When it happened (Unix ms, executor clock). */
  readonly at: number;
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
  readonly at: number;
  readonly phase: RunPhase;
  readonly mint: string;
  readonly dryRun: boolean;
  readonly wallets: number;
  readonly counts: Readonly<Record<WalletState, number>>;
}

export type ExecutorEvent = WalletEvent | RunEvent | VerifyEvent;

export interface ExecutorDeps {
  readonly jupiter: JupiterClient;
  readonly orderLimiter: OrderLimiter;
  readonly executeLimiter: ExecuteLimiter;
  readonly sign: OrderSigner;
  /** Chain check before any retry of a wallet whose transaction may have been sent. */
  readonly landing: LandingChecker;
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
  /** Max price above the fleet's first fill, in percent. */
  readonly priceCeilingPercent: number;
  /** "No route" (and HTTP 500) from `/order` is waited out this long, from its first time. */
  readonly noRouteWindowMs: number;
  readonly noRouteBackoffMinMs: number;
  readonly noRouteBackoffMaxMs: number;
  /**
   * Mode B: when the token was detected (executor clock). Wallet times count from it
   * instead of from the start of the run (SPEC 3.6).
   */
  readonly triggeredAt?: number;
  /** Defaults: `LANDING_POLL_MS`, `LANDING_TIMEOUT_MS`. */
  readonly landingPollMs?: number;
  readonly landingTimeoutMs?: number;
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

/** Price of the fleet's first fill: `input / output` lamports per token unit. */
interface EntryPrice {
  readonly input: bigint;
  readonly output: bigint;
}

/** `quote` costs more than `entry` × (100 + percent) / 100. Cross-multiplied, no floats. */
export function aboveCeiling(
  entry: EntryPrice,
  quote: { readonly inAmount: bigint; readonly outAmount: bigint },
  percent: number,
): boolean {
  if (quote.outAmount <= 0n) return true;
  return (
    quote.inAmount * entry.output * 100n > entry.input * quote.outAmount * BigInt(100 + percent)
  );
}

function emptyCounts(): Record<WalletState, number> {
  return Object.fromEntries(WALLET_STATES.map((s) => [s, 0])) as Record<WalletState, number>;
}

export function startRun(deps: ExecutorDeps, options: RunOptions): ExecutorRun {
  const { clock, jupiter } = deps;
  const startedAt = Math.min(options.triggeredAt ?? clock.now(), clock.now());
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
  const pollMs = options.landingPollMs ?? LANDING_POLL_MS;
  const landingTimeoutMs = options.landingTimeoutMs ?? LANDING_TIMEOUT_MS;
  let entry: EntryPrice | null = null;
  /** Mint gate (D-035). */
  const gate = {
    // Starts closed: the run's first /order is a probe, so a mint without a route yet
    // costs one request, not a burst that spends the whole limiter budget (D-035).
    closed: true,
    /**
     * Start of the current window: the first "no route" of the run, or, once the gate has
     * opened, the moment it closed again (each re-close gets a fresh window).
     */
    since: null as number | null,
    /** A route was seen in this run. */
    everOpened: false,
    /**
     * When the next probe became ready to go. The time until it actually goes (waiting
     * for the limiter) is not time without a route: the window moves on by it (D-035).
     */
    readyAt: null as number | null,
    /** Backoff steps since the gate last closed. */
    backoffs: 0,
    /** A probe /order is in flight. */
    probing: false,
  };
  /** The probe wallet waiting out its backoff, or null. */
  let probeWaiting: number | null = null;
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
      at: clock.now(),
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
      at: clock.now(),
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

  const windowOver = (): boolean =>
    gate.since !== null && clock.now() - gate.since >= options.noRouteWindowMs;

  /** The window ended without a route: every waiting wallet fails, no more requests. */
  const failWaiting = (detail: string): void => {
    for (const waiting of queue.splice(0)) fail(waiting, 'NO_ROUTE', detail);
    if (probeWaiting !== null) {
      const probe = probeWaiting;
      probeWaiting = null;
      fail(probe, 'NO_ROUTE', detail);
    }
  };

  /**
   * No route yet (400 "no route" or 500): closes the mint gate. The wallet that closed it,
   * or the probe, waits out a backoff and probes again; any other wallet waits in the
   * queue. No attempt is used. After the window everyone waiting fails.
   */
  const noRoute = (index: number, detail: string, wasProbe: boolean): void => {
    const slot = slotOf(index);
    if (!gate.closed && gate.everOpened) {
      gate.since = clock.now(); // the route was there and is gone: a fresh window
    } else {
      gate.since ??= clock.now();
    }
    if (windowOver()) {
      fail(index, 'NO_ROUTE', detail);
      failWaiting(detail);
      nudge();
      return;
    }
    move(index, 'QUEUED');
    slot.attempt -= 1; // inside the window "no route" does not use attempts
    if (stopped) {
      skip(index, 'STOPPED');
      return;
    }
    const becomesProbe = (!gate.closed || wasProbe) && probeWaiting === null;
    gate.closed = true;
    if (!becomesProbe) {
      // A request that was already in flight: it waits with everyone else.
      queue.push(index);
      nudge();
      return;
    }
    const delay = Math.min(
      options.noRouteBackoffMinMs * 2 ** gate.backoffs,
      options.noRouteBackoffMaxMs,
    );
    gate.backoffs += 1;
    probeWaiting = index;
    void clock.sleep(delay).then(() => {
      // STOP or the end of the window may have settled it meanwhile.
      if (probeWaiting !== index) return;
      probeWaiting = null;
      if (windowOver()) {
        fail(index, 'NO_ROUTE', detail);
        failWaiting(detail);
      } else {
        queue.unshift(index); // the probe goes first
        gate.readyAt = clock.now();
      }
      nudge();
    });
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
      case 'noRoute':
        // Only reachable after /order: the caller passes whether it was the probe.
        throw new Error('noRoute outside /order');
      case 'check':
        // Only reachable after /execute: the caller runs the chain check.
        throw new Error('check outside /execute');
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
    const { totalInputAmount: input, totalOutputAmount: output } = execution;
    if (entry === null && input !== null && output !== null && input > 0n && output > 0n) {
      entry = { input, output };
    }
    move(index, 'CONFIRMED');
  };

  /**
   * The transaction may be on the chain: the wallet is UNKNOWN until the chain decides.
   * Never retried before the chain shows it did not land and cannot land any more.
   */
  const resolve = async (index: number, query: LandingQuery, detail: string): Promise<void> => {
    const slot = slotOf(index);
    unknown(index, 'EXECUTE_NO_ANSWER', detail);
    const deadline = clock.now() + landingTimeoutMs;
    for (;;) {
      let landing: Landing;
      try {
        landing = await deps.landing(query);
      } catch {
        landing = { status: 'pending' };
      }
      switch (landing.status) {
        case 'landed':
          slot.result = {
            signature: landing.signature,
            slot: landing.slot,
            totalInputAmount: slot.result?.totalInputAmount ?? null,
            totalOutputAmount: slot.result?.totalOutputAmount ?? null,
          };
          move(index, 'CONFIRMED');
          return;
        case 'failed':
          slot.result = {
            signature: landing.signature,
            slot: null,
            totalInputAmount: null,
            totalOutputAmount: null,
          };
          requeue(index, true, `LANDED_WITH_ERROR:${detail}`);
          return;
        case 'expired':
          requeue(index, true, `NOT_LANDED:${detail}`);
          return;
        case 'pending':
          break;
      }
      if (clock.now() >= deadline) {
        unknown(index, 'LANDING_UNRESOLVED', detail);
        return;
      }
      await clock.sleep(pollMs);
    }
  };

  /** One attempt of one wallet: /order → sign → /execute. Never throws on data. */
  const attempt = async (index: number, probe: boolean): Promise<void> => {
    const slot = slotOf(index);
    const { wallet } = slot;
    slot.attempt += 1;
    // A result of an earlier attempt must never be mistaken for this one's.
    slot.result = null;
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
    if (probe) gate.probing = false;
    if (!ordered.ok) {
      const decision = afterOrderFailure(ordered);
      if (decision.action === 'noRoute') {
        noRoute(index, decision.detail, probe);
      } else {
        // A probe that learned nothing (timeout, 429): the next one is ready now.
        if (probe && gate.closed) gate.readyAt = clock.now();
        apply(index, decision);
      }
      nudge();
      return;
    }
    // A route (even with a build error for this wallet) opens the gate for everyone.
    if (gate.closed) {
      gate.closed = false;
      gate.everOpened = true;
      gate.backoffs = 0;
      nudge();
    }
    const order = ordered.value;
    slot.quote = { inAmount: order.inAmount, outAmount: order.outAmount, router: order.router };
    if (order.buildError !== null) {
      apply(index, afterBuildError(order.buildError.reason));
      return;
    }
    if (entry !== null && aboveCeiling(entry, order, options.priceCeilingPercent)) {
      skip(index, 'PRICE_CEILING');
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
    const query: LandingQuery = {
      taker: wallet.address,
      signedTransaction: signed.signedTransaction,
      signature: signed.signature,
      lastValidBlockHeight: order.lastValidBlockHeight,
      expireAt: order.expireAt,
      sentAtMs: executeStart,
    };
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
      const failure = afterExecuteFailure(executed);
      if (failure.action === 'check') {
        await resolve(
          index,
          { ...query, signature: executed.signature ?? query.signature },
          failure.detail,
        );
      } else apply(index, failure);
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
    if (decision.action === 'check') {
      await resolve(
        index,
        { ...query, signature: executed.value.signature ?? query.signature },
        decision.detail,
      );
    } else apply(index, decision);
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

    /** Closed gate with its probe busy (in flight or in backoff): everyone else waits. */
    const gateBusy = (): boolean => gate.closed && (gate.probing || probeWaiting !== null);
    while (fatal === null && !stopped) {
      if (queue.length === 0 || gateBusy()) {
        if (queue.length === 0 && inFlight === 0 && probeWaiting === null) break;
        await idle();
        continue;
      }
      if (!(await deps.orderLimiter.acquire(stopSignal.signal))) break;
      if (isStopped()) break;
      // The gate may have closed while waiting for the limiter.
      if (gateBusy()) continue;
      const index = queue.shift();
      if (index === undefined) continue;
      const probe = gate.closed;
      if (probe) {
        gate.probing = true;
        if (gate.readyAt !== null && gate.since !== null) gate.since += clock.now() - gate.readyAt;
        gate.readyAt = null;
      }
      inFlight += 1;
      void attempt(index, probe)
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
    if (probeWaiting !== null) {
      const probe = probeWaiting;
      probeWaiting = null;
      skip(probe, 'STOPPED');
    }
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
