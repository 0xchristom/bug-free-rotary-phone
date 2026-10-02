/**
 * Jupiter check for the connection test (SPEC 3.3, BUNNDLY-16): `GET /swap/v2/order`
 * SOL → USDC for a small amount WITHOUT `taker`, so the answer is a quote only
 * (`transaction: null`) and nothing can be signed or executed. Never calls `/execute`.
 * Uses the same client as the executor (BUNNDLY-19).
 * Docs: https://developers.jup.ag/docs/swap/order-and-execute.md
 */
import type {
  ConnectionProblem,
  FetchLike,
  JupiterCheck,
  RateLimitHeaders,
} from '../core/connection.ts';
import {
  JUPITER_SWAP_URL,
  createJupiterClient,
  orderUrl,
  type JupiterFailureCode,
} from './client.ts';

export { SOL_MINT } from './client.ts';

export const JUPITER_ORDER_URL = `${JUPITER_SWAP_URL}/order`;

/**
 * USDC on Solana (6 decimals). Source: Circle,
 * https://developers.circle.com/stablecoins/usdc-contract-addresses, and the SOL → USDC
 * example in https://developers.jup.ag/docs/swap/order-and-execute.md
 */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

/** 0.01 SOL: enough for a real route, small enough to be clearly a test. */
export const TEST_QUOTE_LAMPORTS = 10_000_000n;

export interface QuoteCheckOptions {
  /** Jupiter key; null for the Keyless plan (no `x-api-key` header). */
  readonly apiKey: string | null;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly clock: () => number;
}

export function quoteUrl(): string {
  return orderUrl({ outputMint: USDC_MINT, amount: TEST_QUOTE_LAMPORTS });
}

const PROBLEMS: Record<JupiterFailureCode, ConnectionProblem> = {
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  NO_ROUTE: 'HTTP_ERROR',
  BAD_REQUEST: 'HTTP_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
};

export async function checkJupiterQuote(options: QuoteCheckOptions): Promise<JupiterCheck> {
  const keyless = options.apiKey === null;
  const start = options.clock();
  const elapsed = (): number => Math.round(options.clock() - start);
  const fail = (
    problem: ConnectionProblem,
    httpStatus: number | null,
    rateLimit: RateLimitHeaders | null,
  ): JupiterCheck => ({
    ok: false,
    ms: elapsed(),
    problem,
    httpStatus,
    keyless,
    outAmount: null,
    router: null,
    rateLimit,
  });

  const client = createJupiterClient({
    apiKey: options.apiKey,
    fetch: options.fetch,
    orderTimeoutMs: options.timeoutMs,
  });
  const result = await client.getOrder({ outputMint: USDC_MINT, amount: TEST_QUOTE_LAMPORTS });
  if (!result.ok) {
    // Statuses of failed answers are shown only for HTTP errors, as before.
    const status = result.code === 'INVALID_RESPONSE' ? null : result.httpStatus;
    return fail(PROBLEMS[result.code], status, result.rateLimit);
  }
  const order = result.value;
  // Without taker the docs promise a quote only: a transaction here is unexpected.
  if (order.transaction !== null || order.buildError !== null) {
    return fail('INVALID_RESPONSE', null, result.rateLimit);
  }
  return {
    ok: true,
    ms: elapsed(),
    problem: null,
    httpStatus: null,
    keyless,
    outAmount: order.outAmount.toString(),
    router: order.router,
    rateLimit: result.rateLimit,
  };
}
