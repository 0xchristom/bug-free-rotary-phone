/**
 * Helius checks for the connection test (SPEC 3.3, BUNNDLY-16): HTTP `getHealth` +
 * `getSlot`, and WebSocket `slotSubscribe` → first `slotNotification` → `slotUnsubscribe`.
 * Runs in the vault worker, which alone knows the key; results never contain the URL.
 * Methods: https://www.helius.dev/docs/api-reference/rpc/websocket/llms.txt
 */
import {
  isRecord,
  requestJson,
  statusProblem,
  type ConnectionProblem,
  type FetchLike,
  type HeliusHttpCheck,
  type HeliusWsCheck,
} from '../core/connection.ts';

export interface HttpCheckOptions {
  readonly url: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly clock: () => number;
}

const NO_HTTP: Omit<HeliusHttpCheck, 'ok' | 'ms' | 'problem' | 'httpStatus'> = { slot: null };

/** `getHealth` then `getSlot`; the time is the sum of both round trips. */
export async function checkHeliusHttp(options: HttpCheckOptions): Promise<HeliusHttpCheck> {
  const start = options.clock();
  const elapsed = (): number => Math.round(options.clock() - start);
  const fail = (problem: ConnectionProblem, httpStatus: number | null = null): HeliusHttpCheck => ({
    ...NO_HTTP,
    ok: false,
    ms: elapsed(),
    problem,
    httpStatus,
  });

  const call = async (id: number, method: string) => {
    const outcome = await requestJson(
      options.fetch,
      options.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method }),
      },
      options.timeoutMs,
    );
    if (outcome.kind === 'failed') return { problem: outcome.problem, status: null };
    if (outcome.status !== 200) {
      return { problem: statusProblem(outcome.status), status: outcome.status };
    }
    const body = outcome.json;
    if (!isRecord(body) || body.id !== id)
      return { problem: 'INVALID_RESPONSE' as const, status: null };
    if (body.error !== undefined) return { problem: 'RPC_ERROR' as const, status: null };
    return { result: body.result };
  };

  const health = await call(1, 'getHealth');
  if ('problem' in health) {
    return fail(health.problem === 'RPC_ERROR' ? 'UNHEALTHY' : health.problem, health.status);
  }
  if (health.result !== 'ok') return fail('UNHEALTHY');
  const slot = await call(2, 'getSlot');
  if ('problem' in slot) return fail(slot.problem, slot.status);
  if (typeof slot.result !== 'number' || !Number.isSafeInteger(slot.result) || slot.result < 0) {
    return fail('INVALID_RESPONSE');
  }
  return { ok: true, ms: elapsed(), problem: null, httpStatus: null, slot: slot.result };
}

/** The part of the browser WebSocket the check uses (mocked in tests). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WsCheckOptions {
  readonly url: string;
  readonly createWebSocket: WebSocketFactory;
  readonly timeoutMs: number;
  readonly clock: () => number;
}

const SUBSCRIBE_ID = 1;
const UNSUBSCRIBE_ID = 2;

/**
 * Opens the socket, subscribes to slots, waits for the first notification, unsubscribes
 * and closes. A browser does not say why a handshake failed (401 and a wrong host look
 * the same), so a socket that never opened is WS_REFUSED.
 */
export function checkHeliusWs(options: WsCheckOptions): Promise<HeliusWsCheck> {
  return new Promise((resolve) => {
    const start = options.clock();
    const since = (): number => Math.round(options.clock() - start);
    let connectMs: number | null = null;
    let firstEventMs: number | null = null;
    let slot: number | null = null;
    let subscription: number | null = null;
    let done = false;
    let socket: WebSocketLike | null = null;

    const finish = (problem: ConnectionProblem | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve({
        ok: problem === null,
        ms: since(),
        problem,
        httpStatus: null,
        connectMs,
        firstEventMs,
        slot,
      });
    };

    // After the first event the check has passed; a missing unsubscribe answer only
    // means the socket is closed without it.
    const timer = setTimeout(() => {
      finish(firstEventMs === null ? 'TIMEOUT' : null);
    }, options.timeoutMs);

    try {
      socket = options.createWebSocket(options.url);
    } catch {
      finish('WS_REFUSED');
      return;
    }
    const ws = socket;
    ws.addEventListener('open', () => {
      connectMs = since();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: SUBSCRIBE_ID, method: 'slotSubscribe' }));
    });
    ws.addEventListener('error', () => {
      finish(connectMs === null ? 'WS_REFUSED' : 'WS_CLOSED');
    });
    ws.addEventListener('close', () => {
      if (firstEventMs !== null) finish(null);
      else finish(connectMs === null ? 'WS_REFUSED' : 'WS_CLOSED');
    });
    ws.addEventListener('message', (event) => {
      if (done || typeof event.data !== 'string') return;
      let message: unknown;
      try {
        message = JSON.parse(event.data) as unknown;
      } catch {
        finish('INVALID_RESPONSE');
        return;
      }
      if (!isRecord(message)) {
        finish('INVALID_RESPONSE');
        return;
      }
      if (message.id === SUBSCRIBE_ID) {
        if (message.error !== undefined) {
          finish('RPC_ERROR');
          return;
        }
        if (typeof message.result !== 'number') {
          finish('INVALID_RESPONSE');
          return;
        }
        subscription = message.result;
        return;
      }
      if (message.id === UNSUBSCRIBE_ID) {
        finish(null);
        return;
      }
      if (message.method === 'slotNotification' && firstEventMs === null && subscription !== null) {
        const params = message.params;
        const result = isRecord(params) && isRecord(params.result) ? params.result : null;
        if (result === null || typeof result.slot !== 'number') {
          finish('INVALID_RESPONSE');
          return;
        }
        firstEventMs = since();
        slot = result.slot;
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: UNSUBSCRIBE_ID,
            method: 'slotUnsubscribe',
            params: [subscription],
          }),
        );
      }
    });
  });
}
