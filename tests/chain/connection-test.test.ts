/** Helius HTTP and WSS checks (BUNNDLY-16) against mocked fetch and WebSocket. */
import { describe, expect, it } from 'vitest';
import { checkHeliusHttp, checkHeliusWs } from '../../src/chain/connection-test.ts';
import { FakeSocket, fakeFetch, flush, heliusSocket, stepClock } from '../helpers/net-fakes.ts';

const KEY = 'heliusSecretKey777';
const URL_HTTP = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const URL_WS = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;

function methodOf(body: unknown): string {
  return (body as { method: string }).method;
}

function rpcOk(body: unknown, result: unknown) {
  return { status: 200, json: { jsonrpc: '2.0', id: (body as { id: number }).id, result } };
}

describe('Helius HTTP check', () => {
  it('getHealth then getSlot: OK with slot and the time of both calls', async () => {
    const { fetch, calls } = fakeFetch(({ body }) =>
      rpcOk(body, methodOf(body) === 'getHealth' ? 'ok' : 452_673_384),
    );
    const r = await checkHeliusHttp({ url: URL_HTTP, fetch, timeoutMs: 1000, clock: stepClock() });
    expect(r).toEqual({ ok: true, ms: 7, problem: null, httpStatus: null, slot: 452_673_384 });
    expect(calls.map((c) => [c.method, methodOf(c.body)])).toEqual([
      ['POST', 'getHealth'],
      ['POST', 'getSlot'],
    ]);
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVER_ERROR'],
    [404, 'HTTP_ERROR'],
  ] as const)('HTTP %i → %s, with the status and no key anywhere', async (status, problem) => {
    const { fetch } = fakeFetch(() => ({ status, json: { error: `bad key ${KEY}` } }));
    const r = await checkHeliusHttp({ url: URL_HTTP, fetch, timeoutMs: 1000, clock: stepClock() });
    expect(r).toMatchObject({ ok: false, problem, httpStatus: status, slot: null });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('a node that is not healthy, an RPC error and a malformed answer', async () => {
    const unhealthy = fakeFetch(({ body }) => ({
      status: 200,
      json: { jsonrpc: '2.0', id: (body as { id: number }).id, error: { code: -32005 } },
    }));
    expect(
      await checkHeliusHttp({
        url: URL_HTTP,
        fetch: unhealthy.fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: false, problem: 'UNHEALTHY' });

    const slotError = fakeFetch(({ body }) =>
      methodOf(body) === 'getHealth'
        ? rpcOk(body, 'ok')
        : { status: 200, json: { jsonrpc: '2.0', id: 2, error: { code: -32000 } } },
    );
    expect(
      await checkHeliusHttp({
        url: URL_HTTP,
        fetch: slotError.fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: false, problem: 'RPC_ERROR' });

    const garbage = fakeFetch(() => ({ status: 200 }));
    expect(
      await checkHeliusHttp({
        url: URL_HTTP,
        fetch: garbage.fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: false, problem: 'INVALID_RESPONSE' });
  });

  it('timeout and network error: no original error (it carries the URL with the key)', async () => {
    const hang = fakeFetch(() => 'hang');
    const timeout = await checkHeliusHttp({
      url: URL_HTTP,
      fetch: hang.fetch,
      timeoutMs: 20,
      clock: stepClock(),
    });
    expect(timeout).toMatchObject({ ok: false, problem: 'TIMEOUT', httpStatus: null });

    const down = fakeFetch(() => 'network-error');
    const network = await checkHeliusHttp({
      url: URL_HTTP,
      fetch: down.fetch,
      timeoutMs: 1000,
      clock: stepClock(),
    });
    expect(network).toMatchObject({ ok: false, problem: 'NETWORK' });
    expect(JSON.stringify([timeout, network])).not.toContain(KEY);
  });
});

describe('Helius WebSocket check', () => {
  function start(timeoutMs = 1000) {
    const sockets: FakeSocket[] = [];
    const result = checkHeliusWs({
      url: URL_WS,
      createWebSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      timeoutMs,
      clock: stepClock(),
    });
    const socket = sockets[0];
    if (!socket) throw new Error('no socket');
    return { result, socket };
  }

  it('subscribe, first slot, unsubscribe, close: OK with connect and first-event times', async () => {
    const { result, socket } = start();
    heliusSocket(socket, 452_700_000);
    const r = await result;
    expect(r).toEqual({
      ok: true,
      ms: 21,
      problem: null,
      httpStatus: null,
      connectMs: 7,
      firstEventMs: 14,
      slot: 452_700_000,
    });
    expect(socket.url).toBe(URL_WS);
    expect(socket.sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'slotSubscribe' },
      { jsonrpc: '2.0', id: 2, method: 'slotUnsubscribe', params: [23784] },
    ]);
    expect(socket.closed).toBe(true);
  });

  it('a socket that never opens (bad key, wrong host, connection limit) is WS_REFUSED', async () => {
    const { result, socket } = start();
    socket.emit('error');
    socket.emit('close');
    expect(await result).toMatchObject({ ok: false, problem: 'WS_REFUSED', connectMs: null });
  });

  it('closed after opening but before the first event is WS_CLOSED', async () => {
    const { result, socket } = start();
    socket.emit('open');
    socket.emit('close');
    expect(await result).toMatchObject({ ok: false, problem: 'WS_CLOSED', firstEventMs: null });
  });

  it('no event in time is TIMEOUT and the socket is closed', async () => {
    const { result, socket } = start(20);
    socket.emit('open');
    socket.emit('message', { jsonrpc: '2.0', result: 1, id: 1 });
    expect(await result).toMatchObject({ ok: false, problem: 'TIMEOUT' });
    expect(socket.closed).toBe(true);
  });

  it('a missing unsubscribe answer after the first event still passes', async () => {
    const { result, socket } = start(20);
    socket.emit('open');
    socket.emit('message', { jsonrpc: '2.0', result: 5, id: 1 });
    socket.emit('message', { method: 'slotNotification', params: { result: { slot: 9 } } });
    await flush();
    expect(await result).toMatchObject({ ok: true, slot: 9 });
  });

  it('a subscribe error and a malformed message', async () => {
    const a = start();
    a.socket.emit('open');
    a.socket.emit('message', { jsonrpc: '2.0', id: 1, error: { code: -32601 } });
    expect(await a.result).toMatchObject({ ok: false, problem: 'RPC_ERROR' });

    const b = start();
    b.socket.emit('open');
    b.socket.emit('message', 'not json');
    expect(await b.result).toMatchObject({ ok: false, problem: 'INVALID_RESPONSE' });
  });

  it('a constructor that throws (e.g. CSP) is WS_REFUSED without the error', async () => {
    const r = await checkHeliusWs({
      url: URL_WS,
      createWebSocket: (url) => {
        throw new Error(`Refused to connect to ${url}`);
      },
      timeoutMs: 1000,
      clock: stepClock(),
    });
    expect(r).toMatchObject({ ok: false, problem: 'WS_REFUSED' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
