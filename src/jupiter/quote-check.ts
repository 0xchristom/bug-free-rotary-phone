/**
 * Jupiter check for the connection test (SPEC 3.3, BUNNDLY-16): `GET /swap/v2/order`
 * SOL → USDC for a small amount WITHOUT `taker`, so the answer is a quote only
 * (`transaction: null`) and nothing can be signed or executed. Never calls `/execute`.
 * Docs: https://developers.jup.ag/docs/swap/order-and-execute.md
 */
import {
  isRecord,
  parseRateLimit,
  requestJson,
  statusProblem,
  type ConnectionProblem,
  type FetchLike,
  type JupiterCheck,
  type RateLimitHeaders,
} from '../core/connection.ts';

export const JUPITER_ORDER_URL = 'https://api.jup.ag/swap/v2/order';

/**
 * Wrapped SOL (native mint), Jupiter's input mint for SOL.
 * Source: `declare_id!` in https://github.com/solana-program/token/blob/main/interface/src/native_mint.rs
 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: TEST_QUOTE_LAMPORTS.toString(),
  });
  return `${JUPITER_ORDER_URL}?${params.toString()}`;
}

/** Router names are short identifiers (`metis`, `jupiterz`, `dflow`, `okx`). */
const ROUTER = /^[a-z0-9_-]{1,32}$/iu;
const AMOUNT = /^\d{1,30}$/u;

export async function checkJupiterQuote(options: QuoteCheckOptions): Promise<JupiterCheck> {
  const keyless = options.apiKey === null;
  const start = options.clock();
  const elapsed = (): number => Math.round(options.clock() - start);
  const fail = (
    problem: ConnectionProblem,
    httpStatus: number | null,
    rateLimit: RateLimitHeaders | null = null,
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

  const outcome = await requestJson(
    options.fetch,
    quoteUrl(),
    { method: 'GET', headers: options.apiKey === null ? {} : { 'x-api-key': options.apiKey } },
    options.timeoutMs,
  );
  if (outcome.kind === 'failed') return fail(outcome.problem, null);
  // Present on 200 and 429 only (rate-limits.md).
  const rateLimit = parseRateLimit(outcome.headers);
  if (outcome.status !== 200) return fail(statusProblem(outcome.status), outcome.status, rateLimit);
  const body = outcome.json;
  if (
    !isRecord(body) ||
    body.transaction !== null || // without taker the docs promise no transaction
    typeof body.outAmount !== 'string' ||
    !AMOUNT.test(body.outAmount) ||
    typeof body.router !== 'string' ||
    !ROUTER.test(body.router)
  ) {
    return fail('INVALID_RESPONSE', null, rateLimit);
  }
  return {
    ok: true,
    ms: elapsed(),
    problem: null,
    httpStatus: null,
    keyless,
    outAmount: body.outAmount,
    router: body.router,
    rateLimit,
  };
}
