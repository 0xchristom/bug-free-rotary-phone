/**
 * UI-thread client for the vault worker: request ids, Promise responses, timeouts.
 * Errors from the worker arrive as a code only and are rebuilt as AppError.
 */
import { AppError, ERROR_MESSAGES, type ErrorCode } from '../core/index.ts';
import type { VaultPort, VaultRequestOf, VaultRequestType, VaultResultMap } from './protocol.ts';

/** scrypt runs on create and unlock (about 1 s in Node, slower on weak devices). */
export const DEFAULT_SLOW_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
const SLOW_REQUESTS: ReadonlySet<VaultRequestType> = new Set(['create', 'unlock', 'exportPlain']);

export interface VaultClientOptions {
  readonly timeoutMs?: number;
  readonly slowTimeoutMs?: number;
}

export interface VaultRequestOptions {
  /** Progress 0..1 of long requests (scrypt in create and unlock). */
  readonly onProgress?: (progress: number) => void;
}

export interface VaultClient {
  request<T extends VaultRequestType>(
    request: VaultRequestOf<T>,
    options?: VaultRequestOptions,
  ): Promise<VaultResultMap[T]>;
}

interface Pending {
  readonly onProgress: ((progress: number) => void) | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorCode(value: unknown): ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value)
    ? (value as ErrorCode)
    : 'INTERNAL_ERROR';
}

export function createVaultClient(port: VaultPort, options: VaultClientOptions = {}): VaultClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slowTimeoutMs = options.slowTimeoutMs ?? DEFAULT_SLOW_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 1;

  port.addEventListener('message', (event) => {
    const data = event.data;
    if (!isRecord(data) || typeof data.id !== 'number') return;
    const entry = pending.get(data.id);
    if (!entry) return; // late reply after a timeout
    if (!('ok' in data)) {
      if (typeof data.progress === 'number') entry.onProgress?.(data.progress);
      return;
    }
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok === true) {
      entry.resolve(data.result);
    } else {
      entry.reject(new AppError(toErrorCode(data.code)));
    }
  });

  // A failing worker (script error, unreadable message) would otherwise leave every
  // pending request waiting 30–120 s for its timeout.
  port.addFailureListener?.(() => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new AppError('INTERNAL_ERROR'));
    }
  });

  return {
    request<T extends VaultRequestType>(
      request: VaultRequestOf<T>,
      options: VaultRequestOptions = {},
    ): Promise<VaultResultMap[T]> {
      const id = nextId++;
      const limit = SLOW_REQUESTS.has(request.type) ? slowTimeoutMs : timeoutMs;
      return new Promise<VaultResultMap[T]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AppError('VAULT_TIMEOUT'));
        }, limit);
        pending.set(id, {
          onProgress: options.onProgress,
          resolve: (value) => {
            resolve(value as VaultResultMap[T]);
          },
          reject,
          timer,
        });
        port.postMessage({ id, request });
      });
    },
  };
}
