/**
 * Fake Jupiter for executor tests (BUNNDLY-21, used by 23 and 25 too): answers shaped like
 * the real `/order` and `/execute` fixtures, with injected delays and failures on a fake
 * clock. Records every call, and how many calls each wallet has open at once.
 */
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

export type ExecuteOutcome =
  | 'ok'
  | { readonly code: number }
  | {
      readonly fail: JupiterFailureCode;
      readonly httpStatus?: number;
      readonly signature?: string;
    };

export interface FakeJupiterScript {
  readonly orderDelayMs?: (c: CallContext) => number;
  readonly order?: (c: CallContext) => OrderOutcome;
  readonly executeDelayMs?: (c: CallContext) => number;
  readonly execute?: (c: CallContext) => ExecuteOutcome;
  /** Real transaction for the taker (for the vault's signer); a placeholder otherwise. */
  readonly transaction?: (taker: string) => string;
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
  /** Taker of each requestId, so /execute knows the wallet. */
  private readonly requests = new Map<string, string>();

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
    this.requests.set(requestId, taker);
    const base = realOrder('metisSuccess');
    const order: JupiterOrder = {
      ...base,
      requestId,
      taker,
      signatureFeePayer: taker,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: request.amount * 100n,
      transaction:
        outcome === 'ok' ? (this.script.transaction?.(taker) ?? `tx-${requestId}`) : null,
      buildError:
        outcome === 'ok' ? null : { errorCode: outcome.errorCode ?? 1, reason: outcome.build },
    };
    return { ok: true, value: order, rateLimit: null };
  }

  async execute(request: ExecuteRequest): Promise<JupiterResult<JupiterExecution>> {
    const taker = this.requests.get(request.requestId) ?? '';
    const { ctx, end } = this.begin('execute', taker, {
      signedTransaction: request.signedTransaction,
    });
    await this.clock.sleep(this.script.executeDelayMs?.(ctx) ?? 300);
    end();
    const outcome = this.script.execute?.(ctx) ?? 'ok';
    if (outcome !== 'ok' && 'fail' in outcome) {
      return {
        ok: false,
        code: outcome.fail,
        httpStatus: outcome.httpStatus ?? null,
        rateLimit: null,
        signature: outcome.signature ?? null,
      };
    }
    const code = outcome === 'ok' ? 0 : outcome.code;
    const execution: JupiterExecution = {
      status: code === 0 ? 'Success' : 'Failed',
      code,
      outcome: code === 0 ? 'SUCCESS' : 'UNDOCUMENTED',
      signature: fakeSignature(taker, ctx.nth),
      slot: code === 0 ? 452_713_600n : null,
      totalInputAmount: code === 0 ? 10_000_000n : null,
      totalOutputAmount: code === 0 ? 1_180_000n : null,
      inputAmountResult: code === 0 ? 10_000_000n : null,
      outputAmountResult: code === 0 ? 1_180_200n : null,
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
