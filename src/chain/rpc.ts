/**
 * RPC transport for reads (SPEC 2.2): Helius first, with backoff on 429 / 5xx / network
 * errors, then the public mainnet RPC as a read-only fallback (DECISIONS D-020).
 *
 * The Helius URL contains the API key, so no error leaving this module carries the URL,
 * the request or the original error: callers get AppError('RPC_UNAVAILABLE') only.
 * Pure module (no DOM); runs in the vault worker, which alone knows the key (D-016).
 */
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createDefaultRpcTransport,
  isSolanaError,
  type RpcTransport,
} from '@solana/kit';
import { AppError } from '../core/errors.ts';

/** Public mainnet RPC, used only for reads and only after Helius failed. */
export const PUBLIC_RPC_URL = 'https://api.mainnet.solana.com';

export type RpcSource = 'helius' | 'fallback';

export interface ResilientTransportOptions {
  readonly primary: RpcTransport;
  readonly fallback: RpcTransport;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Retries of the primary on 429 / 5xx / network errors before falling back. */
  readonly retries?: number;
  /** First backoff delay; doubles on each retry. */
  readonly baseDelayMs?: number;
  /** Called with the source that answered (for the UI, BUNNDLY-14). */
  readonly onSource?: (source: RpcSource) => void;
}

export const DEFAULT_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 250;

/** HTTP status of a transport error, if it was one. */
export function httpStatusOf(e: unknown): number | undefined {
  return isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
    ? e.context.statusCode
    : undefined;
}

/** 429, 5xx and network failures are worth retrying; other 4xx (e.g. a bad key) are not. */
export function isRetryable(e: unknown): boolean {
  const status = httpStatusOf(e);
  if (status !== undefined) return status === 429 || status >= 500;
  return e instanceof TypeError; // fetch() network failure
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Transport that tries the primary with exponential backoff, then the fallback once.
 * Any final failure becomes RPC_UNAVAILABLE with no cause attached (the URL with the key
 * could be in it).
 */
export function createResilientTransport(options: ResilientTransportOptions): RpcTransport {
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelay = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const transport = async (config: Parameters<RpcTransport>[0]) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await options.primary(config);
        options.onSource?.('helius');
        return response;
      } catch (e) {
        if (!isRetryable(e) || attempt >= retries) break;
        await sleep(baseDelay * 2 ** attempt);
      }
    }
    try {
      const response = await options.fallback(config);
      options.onSource?.('fallback');
      return response;
    } catch {
      throw new AppError('RPC_UNAVAILABLE');
    }
  };
  return transport as RpcTransport;
}

/** Default HTTP transport for a URL (the URL never appears in our errors). */
export function createHttpTransport(url: string): RpcTransport {
  return createDefaultRpcTransport({ url });
}

/** For logs and messages: the URL without its query (where Helius keeps the key). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return '[nieprawidłowy URL]';
  }
}
