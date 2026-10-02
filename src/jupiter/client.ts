/**
 * Jupiter Swap API V2 client (SPEC 2.2, 3.5; BUNNDLY-19): the only module that knows the
 * shape of `/order` and `/execute`. Nothing here throws for a network or API problem:
 * every call returns a typed value or a failure code, so the limiter and the executor can
 * decide what to do. Failures never carry the URL, the key or Jupiter's free-text message.
 *
 * `/order` is called in "ultra" mode only: inputMint, outputMint, amount and taker, no
 * optional parameters (they restrict routing, order-and-execute.md "Routing impact").
 * Docs: https://developers.jup.ag/docs/swap/order-and-execute.md and the OpenAPI spec
 * https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml (D-026).
 */
import {
  isRecord,
  parseRateLimit,
  requestJson,
  type FetchLike,
  type RateLimitHeaders,
} from '../core/connection.ts';

export const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v2';

/**
 * Wrapped SOL (native mint), Jupiter's input mint for SOL.
 * Source: `declare_id!` in https://github.com/solana-program/token/blob/main/interface/src/native_mint.rs
 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Default time limits; `/execute` waits for Jupiter's confirmation polling. */
export const ORDER_TIMEOUT_MS = 10_000;
export const EXECUTE_TIMEOUT_MS = 60_000;

// --- Failures ----------------------------------------------------------------------

/** Why a call gave no usable answer. Retry decisions belong to the executor (BUNNDLY-23). */
export type JupiterFailureCode =
  /** HTTP 429: the window is full; `rateLimit.reset` says when a slot frees up. */
  | 'RATE_LIMITED'
  /** HTTP 5xx. */
  | 'SERVER_ERROR'
  /** No answer in time. After `/execute` the transaction may still land. */
  | 'TIMEOUT'
  /** fetch failed before an answer (offline, DNS, CORS, CSP). */
  | 'NETWORK'
  /** `/order` found no route for the pair and amount (HTTP 400 "Failed to get quotes"). */
  | 'NO_ROUTE'
  /** Any other HTTP 400, e.g. an invalid mint or amount. */
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  /** Another unexpected HTTP status. */
  | 'HTTP_ERROR'
  /** A 2xx answer that is not what the docs describe (missing or malformed field). */
  | 'INVALID_RESPONSE';

export interface JupiterFailure {
  readonly ok: false;
  readonly code: JupiterFailureCode;
  readonly httpStatus: number | null;
  /** Rate limit headers, when the answer had any (Jupiter sends them on 4xx/5xx too). */
  readonly rateLimit: RateLimitHeaders | null;
  /** `/execute` HTTP 500 may still name the signature it sent (it may land). */
  readonly signature: string | null;
}

export interface JupiterSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly rateLimit: RateLimitHeaders | null;
}

export type JupiterResult<T> = JupiterSuccess<T> | JupiterFailure;

// --- /order ---------------------------------------------------------------------------

/**
 * Why Jupiter quoted a price but built no transaction (`transaction: ""`). The meaning of
 * `errorCode` depends on the router (order-and-execute.md "/order error codes").
 */
export type OrderBuildReason =
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_SOL_FOR_GAS'
  | 'BELOW_GASLESS_MINIMUM'
  | 'MISSING_TOKEN_ACCOUNT'
  | 'QUOTE_NOT_BUILDABLE'
  /** A router or code the docs do not list. */
  | 'OTHER';

const AGGREGATOR_ROUTERS: ReadonlySet<string> = new Set(['metis', 'dflow', 'okx']);

export function orderBuildReason(router: string, errorCode: number | null): OrderBuildReason {
  if (AGGREGATOR_ROUTERS.has(router)) {
    if (errorCode === 1) return 'INSUFFICIENT_FUNDS';
    if (errorCode === 2) return 'INSUFFICIENT_SOL_FOR_GAS';
    if (errorCode === 3) return 'BELOW_GASLESS_MINIMUM';
  } else if (router === 'jupiterz') {
    if (errorCode === 1) return 'INSUFFICIENT_FUNDS';
    if (errorCode === 2) return 'MISSING_TOKEN_ACCOUNT';
    if (errorCode === 3) return 'QUOTE_NOT_BUILDABLE';
  }
  return 'OTHER';
}

export interface JupiterOrder {
  readonly requestId: string;
  /** Winning router: `metis`, `jupiterz`, `dflow`, `okx` (others are accepted). */
  readonly router: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  /** Expected output before slippage. */
  readonly outAmount: bigint;
  /** Minimum output after slippage, when given. */
  readonly otherAmountThreshold: bigint | null;
  /**
   * Base64 of the unsigned transaction; null without a taker or when it could not be
   * built (then `buildError` says why).
   */
  readonly transaction: string | null;
  readonly buildError: {
    readonly errorCode: number | null;
    readonly reason: OrderBuildReason;
  } | null;
  readonly taker: string | null;
  /** Gas payers. `signatureFeePayer !== taker` means someone else pays (gasless). */
  readonly signatureFeePayer: string | null;
  readonly prioritizationFeePayer: string | null;
  readonly rentFeePayer: string | null;
  readonly gasless: boolean;
  /** Aggregator transactions: hard expiry (block height). */
  readonly lastValidBlockHeight: bigint | null;
  /** RFQ (JupiterZ) quotes: expiry as Unix seconds. */
  readonly expireAt: number | null;
  readonly feeMint: string | null;
  readonly feeBps: number | null;
  readonly priceImpactPct: string | null;
}

export interface OrderRequest {
  readonly outputMint: string;
  /** Lamports of SOL to spend. */
  readonly amount: bigint;
  /** Wallet that will sign; omit for a quote only (connection test). */
  readonly taker?: string;
}

export interface JupiterClientOptions {
  /** Jupiter key; null for the Keyless plan (no `x-api-key` header). */
  readonly apiKey: string | null;
  readonly fetch: FetchLike;
  readonly orderTimeoutMs?: number;
  readonly executeTimeoutMs?: number;
}

const AMOUNT = /^\d{1,30}$/u;
const ROUTER = /^[a-z0-9_-]{1,32}$/iu;
/** Solana addresses are 32–44 base58 characters. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
/** Solana packets are 1232 bytes; base64 of that is about 1644 characters. */
const MAX_TRANSACTION_BASE64 = 4096;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/u;
const SHORT_TEXT = /^[\w.:-]{1,128}$/u;

function amountOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && AMOUNT.test(value) ? BigInt(value) : undefined;
}

function addressOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && ADDRESS.test(value) ? value : undefined;
}

/** Optional field: missing or null gives null, a bad value gives undefined (invalid). */
function optional<T>(value: unknown, read: (v: unknown) => T | undefined): T | null | undefined {
  return value === undefined || value === null ? null : read(value);
}

/** Validates a 200 answer of `/order`; undefined when it is not a usable order. */
export function parseOrder(body: unknown): JupiterOrder | undefined {
  if (!isRecord(body)) return undefined;
  const requestId = body.requestId;
  const router = body.router;
  const inAmount = amountOf(body.inAmount);
  const outAmount = amountOf(body.outAmount);
  const signatureFeePayer = addressOrNull(body.signatureFeePayer);
  if (
    typeof requestId !== 'string' ||
    !SHORT_TEXT.test(requestId) ||
    typeof router !== 'string' ||
    !ROUTER.test(router) ||
    inAmount === undefined ||
    outAmount === undefined ||
    signatureFeePayer === undefined ||
    typeof body.inputMint !== 'string' ||
    !ADDRESS.test(body.inputMint) ||
    typeof body.outputMint !== 'string' ||
    !ADDRESS.test(body.outputMint)
  ) {
    return undefined;
  }

  const raw = body.transaction;
  let transaction: string | null;
  let buildError: JupiterOrder['buildError'] = null;
  if (raw === null || raw === undefined) {
    transaction = null;
  } else if (raw === '') {
    transaction = null;
    const code = body.errorCode;
    const errorCode = typeof code === 'number' && Number.isInteger(code) ? code : null;
    buildError = { errorCode, reason: orderBuildReason(router, errorCode) };
  } else if (typeof raw === 'string' && raw.length <= MAX_TRANSACTION_BASE64 && BASE64.test(raw)) {
    transaction = raw;
  } else {
    return undefined;
  }

  const otherAmountThreshold = optional(body.otherAmountThreshold, amountOf);
  const taker = optional(body.taker, (v) => addressOrNull(v) ?? undefined);
  const prioritizationFeePayer = optional(
    body.prioritizationFeePayer,
    (v) => addressOrNull(v) ?? undefined,
  );
  const rentFeePayer = optional(body.rentFeePayer, (v) => addressOrNull(v) ?? undefined);
  const lastValidBlockHeight = optional(body.lastValidBlockHeight, amountOf);
  const expireAt = optional(body.expireAt, (v) =>
    typeof v === 'string' && /^\d{1,12}$/u.test(v) ? Number(v) : undefined,
  );
  const feeMint = optional(body.feeMint, (v) => addressOrNull(v) ?? undefined);
  const feeBps = optional(body.feeBps, (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined,
  );
  const priceImpactPct = optional(body.priceImpactPct, (v) =>
    typeof v === 'string' && /^-?\d{1,20}(\.\d{1,30})?(e-?\d{1,3})?$/iu.test(v) ? v : undefined,
  );
  const gasless = body.gasless === undefined ? false : body.gasless;
  if (
    otherAmountThreshold === undefined ||
    taker === undefined ||
    prioritizationFeePayer === undefined ||
    rentFeePayer === undefined ||
    lastValidBlockHeight === undefined ||
    expireAt === undefined ||
    feeMint === undefined ||
    feeBps === undefined ||
    priceImpactPct === undefined ||
    typeof gasless !== 'boolean'
  ) {
    return undefined;
  }
  return {
    requestId,
    router,
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    inAmount,
    outAmount,
    otherAmountThreshold,
    transaction,
    buildError,
    taker,
    signatureFeePayer,
    prioritizationFeePayer,
    rentFeePayer,
    gasless,
    lastValidBlockHeight,
    expireAt,
    feeMint,
    feeBps,
    priceImpactPct,
  };
}

// --- /execute ----------------------------------------------------------------------------

/** Every `code` documented for `/execute` (order-and-execute.md "/execute error codes"). */
export const EXECUTE_CODES = {
  0: 'SUCCESS',
  [-1]: 'ORDER_NOT_FOUND',
  [-2]: 'INVALID_SIGNED_TRANSACTION',
  [-3]: 'INVALID_MESSAGE_BYTES',
  [-1000]: 'AGGREGATOR_FAILED_TO_LAND',
  [-1001]: 'AGGREGATOR_UNKNOWN',
  [-1002]: 'AGGREGATOR_INVALID_TRANSACTION',
  [-1003]: 'AGGREGATOR_NOT_FULLY_SIGNED',
  [-1004]: 'AGGREGATOR_INVALID_BLOCK_HEIGHT',
  [-2000]: 'RFQ_FAILED_TO_LAND',
  [-2001]: 'RFQ_UNKNOWN',
  [-2002]: 'RFQ_INVALID_PAYLOAD',
  [-2003]: 'RFQ_QUOTE_EXPIRED',
  [-2004]: 'RFQ_SWAP_REJECTED',
} as const satisfies Record<number, string>;

export type ExecuteOutcome = (typeof EXECUTE_CODES)[keyof typeof EXECUTE_CODES] | 'UNDOCUMENTED';

export function executeOutcome(code: number): ExecuteOutcome {
  return Object.hasOwn(EXECUTE_CODES, code)
    ? EXECUTE_CODES[code as keyof typeof EXECUTE_CODES]
    : 'UNDOCUMENTED';
}

export interface JupiterExecution {
  readonly status: 'Success' | 'Failed';
  readonly code: number;
  readonly outcome: ExecuteOutcome;
  readonly signature: string | null;
  readonly slot: bigint | null;
  /** Taken from the wallet, including an input-side fee. */
  readonly totalInputAmount: bigint | null;
  /** Reflected in the wallet, after an output-side fee. */
  readonly totalOutputAmount: bigint | null;
  readonly inputAmountResult: bigint | null;
  readonly outputAmountResult: bigint | null;
}

export interface ExecuteRequest {
  readonly signedTransaction: string;
  readonly requestId: string;
  readonly lastValidBlockHeight?: bigint;
}

/**
 * Validates an `/execute` answer: the 200 body, or a 400 body that carries a documented
 * `code` (e.g. -1 for an expired order). Undefined when it is not usable.
 */
export function parseExecution(body: unknown): JupiterExecution | undefined {
  if (!isRecord(body)) return undefined;
  const code = body.code;
  if (typeof code !== 'number' || !Number.isInteger(code)) return undefined;
  const status = body.status ?? (code === 0 ? undefined : 'Failed');
  if (status !== 'Success' && status !== 'Failed') return undefined;
  if (status === 'Success' && code !== 0) return undefined;
  const signature = optional(body.signature, (v) =>
    typeof v === 'string' && SIGNATURE.test(v) ? v : undefined,
  );
  const slot = optional(body.slot, amountOf);
  const totalInputAmount = optional(body.totalInputAmount, amountOf);
  const totalOutputAmount = optional(body.totalOutputAmount, amountOf);
  const inputAmountResult = optional(body.inputAmountResult, amountOf);
  const outputAmountResult = optional(body.outputAmountResult, amountOf);
  if (
    signature === undefined ||
    slot === undefined ||
    totalInputAmount === undefined ||
    totalOutputAmount === undefined ||
    inputAmountResult === undefined ||
    outputAmountResult === undefined
  ) {
    return undefined;
  }
  return {
    status,
    code,
    outcome: executeOutcome(code),
    signature,
    slot,
    totalInputAmount,
    totalOutputAmount,
    inputAmountResult,
    outputAmountResult,
  };
}

// --- Client ----------------------------------------------------------------------------

function failure(
  code: JupiterFailureCode,
  httpStatus: number | null,
  rateLimit: RateLimitHeaders | null,
  signature: string | null = null,
): JupiterFailure {
  return { ok: false, code, httpStatus, rateLimit, signature };
}

function httpFailure(status: number): JupiterFailureCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 400) return 'BAD_REQUEST';
  return 'HTTP_ERROR';
}

/** Jupiter's answer for a pair or amount it cannot route (checked on mainnet, D-026). */
function isNoRoute(body: unknown): boolean {
  return (
    isRecord(body) &&
    typeof body.error === 'string' &&
    /failed to get quotes|no route/iu.test(body.error)
  );
}

export interface JupiterClient {
  getOrder(request: OrderRequest): Promise<JupiterResult<JupiterOrder>>;
  execute(request: ExecuteRequest): Promise<JupiterResult<JupiterExecution>>;
}

/** URL of `/order` for a request: exactly the four documented required parameters. */
export function orderUrl(request: OrderRequest): string {
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: request.outputMint,
    amount: request.amount.toString(),
  });
  if (request.taker !== undefined) params.set('taker', request.taker);
  return `${JUPITER_SWAP_URL}/order?${params.toString()}`;
}

export function createJupiterClient(options: JupiterClientOptions): JupiterClient {
  const keyHeader: Record<string, string> =
    options.apiKey === null ? {} : { 'x-api-key': options.apiKey };
  const orderTimeoutMs = options.orderTimeoutMs ?? ORDER_TIMEOUT_MS;
  const executeTimeoutMs = options.executeTimeoutMs ?? EXECUTE_TIMEOUT_MS;

  return {
    async getOrder(request) {
      if (request.amount <= 0n) return failure('BAD_REQUEST', null, null);
      const outcome = await requestJson(
        options.fetch,
        orderUrl(request),
        { method: 'GET', headers: { ...keyHeader } },
        orderTimeoutMs,
      );
      if (outcome.kind === 'failed') return failure(outcome.problem, null, null);
      const rateLimit = parseRateLimit(outcome.headers);
      if (outcome.status !== 200) {
        const code =
          outcome.status === 400 && isNoRoute(outcome.json)
            ? 'NO_ROUTE'
            : httpFailure(outcome.status);
        return failure(code, outcome.status, rateLimit);
      }
      const order = parseOrder(outcome.json);
      return order === undefined
        ? failure('INVALID_RESPONSE', 200, rateLimit)
        : { ok: true, value: order, rateLimit };
    },

    async execute(request) {
      const body: Record<string, string> = {
        signedTransaction: request.signedTransaction,
        requestId: request.requestId,
      };
      if (request.lastValidBlockHeight !== undefined) {
        body.lastValidBlockHeight = request.lastValidBlockHeight.toString();
      }
      const outcome = await requestJson(
        options.fetch,
        `${JUPITER_SWAP_URL}/execute`,
        {
          method: 'POST',
          headers: { ...keyHeader, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        executeTimeoutMs,
      );
      if (outcome.kind === 'failed') return failure(outcome.problem, null, null);
      const rateLimit = parseRateLimit(outcome.headers);
      if (outcome.status === 200 || outcome.status === 400) {
        const execution = parseExecution(outcome.json);
        if (execution !== undefined) return { ok: true, value: execution, rateLimit };
        return failure(
          outcome.status === 200 ? 'INVALID_RESPONSE' : 'BAD_REQUEST',
          outcome.status,
          rateLimit,
        );
      }
      // A 500 may still name the signature it sent: the swap can land (UNKNOWN).
      const json = outcome.json;
      const signature =
        isRecord(json) && typeof json.signature === 'string' && SIGNATURE.test(json.signature)
          ? json.signature
          : null;
      return failure(httpFailure(outcome.status), outcome.status, rateLimit, signature);
    },
  };
}
