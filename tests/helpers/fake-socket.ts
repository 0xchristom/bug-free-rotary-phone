/** Fake browser WebSocket for the watcher (BUNNDLY-32, BUNNDLY-34): the test plays the server. */
import type { WebSocketLike } from '../../src/chain/connection-test.ts';

type Listener = (event: { readonly data: unknown }) => void;

export class FakeSocket implements WebSocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly createdAt: number) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  open(): void {
    this.fire('open');
  }
  /** The server confirms `logsSubscribe` with a subscription id. */
  subscribed(): void {
    this.fire('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
  }
  /** Opens and confirms the subscription: the stream is `connected`. */
  connect(): void {
    this.open();
    this.subscribed();
  }
  /** The server answers a request (any JSON-RPC message with its id). */
  reply(id: unknown): void {
    this.fire('message', JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601 } }));
  }
  notify(signature: string, err: unknown = null, logs: string[] = ['Program log: x']): void {
    this.fire(
      'message',
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: {
          result: { context: { slot: 1 }, value: { signature, err, logs } },
          subscription: 7,
        },
      }),
    );
  }
  sentMethods(): unknown[] {
    return this.sent.map((m) => m.method);
  }
  /** Delivers a raw server message (e.g. a real `logsNotification` from fixtures). */
  message(data: unknown): void {
    this.fire('message', JSON.stringify(data));
  }
}
