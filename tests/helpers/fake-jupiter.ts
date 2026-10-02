/**
 * Fake Jupiter for executor tests (BUNNDLY-21, used by 23 and 25 too): answers shaped like
 * the real `/order` and `/execute` fixtures, with injected delays and failures on a fake
 * clock. Records every call, and how many calls each wallet has open at once.
 *
 * With a fake chain (BUNNDLY-23), a successful `/execute` lands its transaction, and a
 * scripted outcome can land it too (also after the answer, or after a timeout), so the
 * executor's chain check is tested against what really happened.
 */
import { executeOutcome } from '../../src/jupiter/client.ts';
import type {
  ExecuteRequest,
  JupiterClient,
  JupiterExecution,
  JupiterFailureCode,
  JupiterOrder,
  JupiterResult,
  OrderBuildReason,
  OrderRequest,
} from '../../src/jupiter/client.ts';
import type { FakeChain } from './fake-chain.ts';
import type { FakeClock } from './fake-clock.ts';
import { realOrder } from './tx-fakes.ts';

export interface CallContext {
  readonly taker: string;
  /** 1 for the wallet's first call of this kind. */
  readonly nth: number;
}

export type OrderOutcome =
  | 'ok'
  | { readonly fail: JupiterFailureCode; readonly httpStatus?: number }
  | { readonly build: OrderBuildReason; readonly errorCode?: number };

/** The transaction lands on the fake chain `afterMs` after `/execute` started. */
export interface LandSpec {
  readonly ok?: boolean;
  readonly afterMs?: number;
}

export type ExecuteOutcome =
  | 'ok'
  | { readonly code: number; readonly lands?: LandSpec }
  | {
      readonly fail: JupiterFailureCode;
      readonly httpStatus?: number;
      readonly signature?: string;
      readonly lands?: LandSpec;
    };

export interface FakeJupiterScript {
  readonly orderDelayMs?: (c: CallContext) => number;
  readonly order?: (c: CallContext) => OrderOutcome;
  readonly executeDelayMs?: (c: CallContext) => number;
  readonly execute?: (c: CallContext) => ExecuteOutcome;
  /** Real transaction for the taker (for the vault's signer); a placeholder otherwise. */
  readonly transaction?: (taker: string) => string;
  /** JupiterZ quote: no block height, `expireAt` 30 s ahead, signature unknown. */
  readonly rfq?: (c: CallContext) => boolean;
  /** Tokens out for the quote (default `amount × 100`). */
  readonly outAmount?: (c: CallContext & { readonly amount: bigint }) => bigint;
  readonly chain?: FakeChain;
}

export interface FakeCall {
  readonly kind: 'order' | 'execute';
  readonly taker: string;
  readonly start: number;
  end: number | null;
  readonly signedTransaction?: string;
}

/** Deterministic 88-character base58 signature for a taker and attempt. */
export function fakeSignature(taker: string, nth: number): string {
  const seed = `${taker}${String(nth)}`.replace(/[^1-9A-HJ-NP-Za-km-z]/gu, '');
  return (seed.repeat(4) + '1'.repeat(88)).slice(0, 88);
}

export class FakeJupiter implements JupiterClient {
  readonly calls: FakeCall[] = [];
  /** Highest number of calls one wallet had open at the same time. */
  maxOpenPerWallet = 0;
  private readonly open = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  /** Each requestId's order, so /execute knows the wallet and the amounts. */
  private readonly requests = new Map<string, JupiterOrder>();

  constructor(
    private readonly clock: FakeClock,
    private readonly script: FakeJupiterScript = {},
  ) {}

  private begin(kind: 'order' | 'execute', taker: string, extra: Partial<FakeCall> = {}) {
    const key = `${kind}:${taker}`;
    const nth = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, nth);
    const open = (this.open.get(taker) ?? 0) + 1;
    this.open.set(taker, open);
    this.maxOpenPerWallet = Math.max(this.maxOpenPerWallet, open);
    const call: FakeCall = { kind, taker, start: this.clock.now(), end: null, ...extra };
    this.calls.push(call);
    return {
      ctx: { taker, nth },
      end: () => {
        call.end = this.clock.now();
        this.open.set(taker, (this.open.get(taker) ?? 1) - 1);
      },
    };
  }

  async getOrder(request: OrderRequest): Promise<JupiterResult<JupiterOrder>> {
    const taker = request.taker ?? '';
    const { ctx, end } = this.begin('order', taker);
    await this.clock.sleep(this.script.orderDelayMs?.(ctx) ?? 100);
    end();
    const outcome = this.script.order?.(ctx) ?? 'ok';
    if (outcome !== 'ok' && 'fail' in outcome) {
      return {
        ok: false,
        code: outcome.fail,
        httpStatus: outcome.httpStatus ?? null,
        rateLimit: null,
        signature: null,
      };
    }
    const requestId = `req-${taker}-${String(ctx.nth)}`;
    const base = realOrder('metisSuccess');
    const rfq = this.script.rfq?.(ctx) ?? false;
    const chain = this.script.chain;
    const order: JupiterOrder = {
      ...base,
      requestId,
      taker,
      router: rfq ? 'jupiterz' : base.router,
      signatureFeePayer: rfq ? 'MarketMaker1111111111111111111111111111111' : taker,
      lastValidBlockHeight: rfq ? null : chain ? chain.height() + 150n : base.lastValidBlockHeight,
      expireAt: rfq ? Math.floor(this.clock.now() / 1000) + 30 : null,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount:
        this.script.outAmount?.({ ...ctx, amount: request.amount }) ?? request.amount * 100n,
      transaction:
        outcome === 'ok' ? (this.script.transaction?.(taker) ?? `tx-${requestId}`) : null,
      buildError:
        outcome === 'ok' ? null : { errorCode: outcome.errorCode ?? 1, reason: outcome.build },
    };
    this.requests.set(requestId, order);
    return { ok: true, value: order, rateLimit: null };
  }

  async execute(request: ExecuteRequest): Promise<JupiterResult<JupiterExecution>> {
    const order = this.requests.get(request.requestId);
    const taker = order?.taker ?? '';
    const { ctx, end } = this.begin('execute', taker, {
      signedTransaction: request.signedTransaction,
    });
    const start = this.clock.now();
    const outcome = this.script.execute?.(ctx) ?? 'ok';
    const signature = fakeSignature(taker, ctx.nth);
    const land = (spec: LandSpec, at: number): boolean =>
      order !== undefined &&
      this.script.chain !== undefined &&
      this.script.chain.land({
        taker,
        signedTransaction: request.signedTransaction,
        signature,
        ok: spec.ok ?? true,
        at,
        spent: order.inAmount,
        lastValidBlockHeight: order.lastValidBlockHeight,
        expireAt: order.expireAt,
      });
    await this.clock.sleep(this.script.executeDelayMs?.(ctx) ?? 300);
    end();
    if (outcome === 'ok') {
      // Success means it landed; an expired transaction cannot, so it fails to land.
      if (this.script.chain && !land({ ok: true }, this.clock.now())) {
        return this.answer(taker, ctx.nth, -1000, order);
      }
    } else if (outcome.lands) {
      land(outcome.lands, start + (outcome.lands.afterMs ?? 0));
    }
    if (outcome !== 'ok' && 'fail' in outcome) {
      return {
        ok: false,
        code: outcome.fail,
        httpStatus: outcome.httpStatus ?? null,
        rateLimit: null,
        signature: outcome.signature ?? null,
      };
    }
    return this.answer(taker, ctx.nth, outcome === 'ok' ? 0 : outcome.code, order);
  }

  private answer(
    taker: string,
    nth: number,
    code: number,
    order: JupiterOrder | undefined,
  ): JupiterResult<JupiterExecution> {
    const ok = code === 0;
    const execution: JupiterExecution = {
      status: ok ? 'Success' : 'Failed',
      code,
      outcome: executeOutcome(code),
      // RFQ: the market maker's signature is not known to the taker.
      signature: order?.router === 'jupiterz' && !ok ? null : fakeSignature(taker, nth),
      slot: ok ? 452_713_600n : null,
      totalInputAmount: ok ? (order?.inAmount ?? null) : null,
      totalOutputAmount: ok ? (order?.outAmount ?? null) : null,
      inputAmountResult: ok ? (order?.inAmount ?? null) : null,
      outputAmountResult: ok ? (order?.outAmount ?? null) : null,
    };
    return { ok: true, value: execution, rateLimit: null };
  }

  ordersOf(taker: string): number {
    return this.calls.filter((c) => c.kind === 'order' && c.taker === taker).length;
  }

  executions(): FakeCall[] {
    return this.calls.filter((c) => c.kind === 'execute');
  }
}

/** Small seeded PRNG (mulberry32) for reproducible random failures. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
