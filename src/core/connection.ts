/**
 * Connection test (SPEC 3.3, BUNNDLY-16): result types shared by the vault worker and the
 * UI, Polish messages and small pure helpers. Results carry only statuses, times and
 * public data from the answers, never a key or a URL with a key (D-016, D-024).
 */

/** Why a check failed. The worker sends the code; the UI shows the message. */
export const CONNECTION_PROBLEMS = {
  KEY_MISSING: 'The Helius API key is missing. Add it in Settings and save.',
  UNAUTHORIZED: 'The service rejected the API key (HTTP 401). Check that the key is correct.',
  FORBIDDEN:
    'Access forbidden (HTTP 403). The key has no access to this service or a firewall rule blocks it.',
  RATE_LIMITED: 'Rate limit exceeded (HTTP 429). Wait a moment and try again.',
  SERVER_ERROR: 'Service error (HTTP 5xx). Try again in a moment.',
  HTTP_ERROR: 'The service answered with an unexpected HTTP code.',
  TIMEOUT: 'The service did not answer in time.',
  NETWORK:
    'Could not connect to the service. Check your internet connection; in the hosted version the cause may also be CSP.',
  INVALID_RESPONSE: 'The service returned an answer in an unexpected format.',
  RPC_ERROR: 'The RPC node returned a request error.',
  UNHEALTHY: 'The Helius node reports that it is not healthy (getHealth).',
  WS_REFUSED:
    'The WebSocket connection could not be opened. The browser gives no reason: check the key, the WSS address and the limit of 5 concurrent connections on the Free plan.',
  WS_CLOSED: 'The WebSocket connection was closed before the first event.',
} as const satisfies Record<string, string>;

export type ConnectionProblem = keyof typeof CONNECTION_PROBLEMS;

/**
 * Jupiter rate limit headers (https://developers.jup.ag/docs/portal/rate-limits.md), raw
 * values as received. Each may be missing; `x-ratelimit-limit` is not sent at all. The
 * values are shown as they are: no plan or window size is derived from them (D-024).
 */
export interface RateLimitHeaders {
  /** Requests left in the window; signed, 0 or negative when over the limit. */
  readonly remaining: number | null;
  /** Requests already used in the window. */
  readonly current: number | null;
  /** Unix time in seconds when the oldest request leaves the window. */
  readonly reset: number | null;
}

export interface ConnectionCheck {
  readonly ok: boolean;
  /** Total time of the check in ms; null when it never started (e.g. no key). */
  readonly ms: number | null;
  readonly problem: ConnectionProblem | null;
  /** HTTP status of the failing answer, when there was one. */
  readonly httpStatus: number | null;
}

export interface HeliusHttpCheck extends ConnectionCheck {
  readonly slot: number | null;
}

export interface HeliusWsCheck extends ConnectionCheck {
  /** From creating the socket to `open`. */
  readonly connectMs: number | null;
  /** From creating the socket to the first `slotNotification`. */
  readonly firstEventMs: number | null;
  readonly slot: number | null;
}

export interface JupiterCheck extends ConnectionCheck {
  /** No Jupiter key: sent without `x-api-key` (Keyless plan). */
  readonly keyless: boolean;
  /** Quoted USDC for the test amount, raw units (6 decimals). */
  readonly outAmount: string | null;
  readonly router: string | null;
  /** Null when the answer had none (401, 403, 5xx, or a plan without limits); never an error. */
  readonly rateLimit: RateLimitHeaders | null;
}

export interface ConnectionReport {
  readonly heliusHttp: HeliusHttpCheck;
  readonly heliusWs: HeliusWsCheck;
  readonly jupiter: JupiterCheck;
  /** ISO-8601 time of the test. */
  readonly testedAt: string;
}

/** Each check gives up after this long. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;

/** Problem for a non-2xx HTTP status. */
export function statusProblem(status: number): ConnectionProblem {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'HTTP_ERROR';
}

/** Reads `x-ratelimit-*`: the integers that came; null when none did. */
export function parseRateLimit(headers: {
  get(name: string): string | null;
}): RateLimitHeaders | null {
  const read = (name: string): number | null => {
    const text = headers.get(name);
    return text !== null && /^-?\d{1,15}$/u.test(text.trim()) ? Number(text.trim()) : null;
  };
  const remaining = read('x-ratelimit-remaining');
  const current = read('x-ratelimit-current');
  const reset = read('x-ratelimit-reset');
  return remaining === null && current === null && reset === null
    ? null
    : { remaining, current, reset };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Outcome of one request: the answer with its JSON body, or why there was none. */
export type HttpOutcome =
  | {
      readonly kind: 'answer';
      readonly status: number;
      readonly headers: { get(name: string): string | null };
      /** Parsed body; null when it is not JSON. */
      readonly json: unknown;
    }
  | { readonly kind: 'failed'; readonly problem: 'TIMEOUT' | 'NETWORK' };

/**
 * One request with a timeout covering the body too. The original error is dropped: its
 * message can contain the URL, and the Helius URL contains the key.
 */
export async function requestJson(
  fetchFn: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      // not JSON: json stays null
    }
    return { kind: 'answer', status: response.status, headers: response.headers, json };
  } catch {
    return { kind: 'failed', problem: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
