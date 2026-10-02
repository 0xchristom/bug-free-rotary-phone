/** Mock fetch and WebSocket for the connection test (BUNNDLY-16). No real network. */
import type { FetchLike } from '../../src/core/connection.ts';
import type { WebSocketLike } from '../../src/chain/connection-test.ts';

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type FetchReply =
  | { readonly status: number; readonly json?: unknown; readonly headers?: Record<string, string> }
  | 'network-error'
  | 'hang';

/** fetch that answers by URL prefix and JSON-RPC method; records every call. */
export function fakeFetch(reply: (call: FetchCall) => FetchReply) {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    };
    calls.push(call);
    const r = reply(call);
    if (r === 'network-error') {
      // Real fetch errors can carry the URL (with the key): it must not leak.
      return Promise.reject(new TypeError(`Failed to fetch ${url}`));
    }
    if (r === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException(`aborted ${url}`, 'AbortError'));
        });
      });
    }
    return Promise.resolve(
      new Response(r.json === undefined ? 'not json' : JSON.stringify(r.json), {
        status: r.status,
        headers: r.headers ?? {},
      }),
    );
  };
  return { fetch, calls };
}

/** Ticks 7 ms per reading, so measured times are known. */
export function stepClock(step = 7): () => number {
  let t = 1000;
  return () => (t += step);
}

type Listener = (event: { readonly data: unknown }) => void;

export class FakeSocket implements WebSocketLike {
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: 'open' | 'error' | 'close'): void;
  emit(type: 'message', data: unknown): void;
  emit(type: string, data?: unknown): void {
    const payload = type === 'message' && typeof data !== 'string' ? JSON.stringify(data) : data;
    for (const l of this.listeners.get(type) ?? []) l({ data: payload });
  }
}

/** A Helius node that behaves as documented: subscribe → notification → unsubscribe. */
export function heliusSocket(socket: FakeSocket, slot = 452_700_000): void {
  socket.emit('open');
  socket.emit('message', { jsonrpc: '2.0', result: 23784, id: 1 });
  socket.emit('message', {
    jsonrpc: '2.0',
    method: 'slotNotification',
    params: { result: { slot, parent: slot - 1, root: slot - 32 }, subscription: 23784 },
  });
  socket.emit('message', { jsonrpc: '2.0', result: true, id: 2 });
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
