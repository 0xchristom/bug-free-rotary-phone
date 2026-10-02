/** testConnections in the vault worker (BUNNDLY-16): saved keys in, statuses out. */
import { describe, expect, it } from 'vitest';
import { AppError, defaultFleetSettings, type ConnectionReport } from '../../src/core/index.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import {
  FakeSocket,
  QUOTE_BODY,
  fakeFetch,
  heliusSocket,
  stepClock,
  type FetchCall,
  type FetchReply,
} from '../helpers/net-fakes.ts';

const PASSWORD = 'correct horse battery staple';
const HELIUS = 'heliusSecretKey777';
const JUPITER = 'jupiterSecretKey555';

const QUOTE = QUOTE_BODY;
const LIMITS = {
  'x-ratelimit-remaining': '58',
  'x-ratelimit-current': '2',
  'x-ratelimit-reset': '1790966971',
};

/** Helius answers JSON-RPC, Jupiter answers the quote; every socket behaves like Helius. */
function network(override?: (call: FetchCall) => FetchReply | undefined) {
  const sockets: FakeSocket[] = [];
  const { fetch, calls } = fakeFetch((call) => {
    const forced = override?.(call);
    if (forced !== undefined) return forced;
    if (call.url.startsWith('https://api.jup.ag/')) {
      return { status: 200, json: QUOTE, headers: LIMITS };
    }
    const body = call.body as { id: number; method: string };
    return {
      status: 200,
      json: { jsonrpc: '2.0', id: body.id, result: body.method === 'getHealth' ? 'ok' : 1234 },
    };
  });
  const net = {
    fetch,
    createWebSocket: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => {
        heliusSocket(socket);
      });
      return socket;
    },
    timeoutMs: 1000,
    clock: stepClock(),
  };
  return { net, calls, sockets };
}

async function fleet(h: VaultHandler, apiKeys: Record<string, string>): Promise<void> {
  await h.handle({ type: 'create', fleetName: 'Test', walletCount: 2, password: PASSWORD });
  await h.handle({ type: 'saveSettings', settings: defaultFleetSettings(), apiKeys });
}

const test = (h: VaultHandler) =>
  h.handle({ type: 'testConnections' }) as Promise<ConnectionReport>;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : 'not an AppError'),
  );
}

describe('testConnections', () => {
  it('runs all three checks with the saved keys; the report has no key or URL', async () => {
    const { net, calls, sockets } = network();
    const h = createVaultHandler({ net, now: () => Date.UTC(2026, 9, 2, 19) });
    await fleet(h, { helius: HELIUS, jupiter: JUPITER });
    const report = await test(h);

    expect(report.heliusHttp).toMatchObject({ ok: true, slot: 1234 });
    expect(report.heliusWs).toMatchObject({ ok: true, slot: 452_700_000 });
    expect(report.jupiter).toMatchObject({
      ok: true,
      keyless: false,
      outAmount: '1174568',
      router: 'metis',
      rateLimit: { remaining: 58, current: 2, reset: 1_790_966_971 },
    });
    expect(report.testedAt).toBe('2026-10-02T19:00:00.000Z');

    expect(calls.filter((c) => c.url.includes('helius')).map((c) => c.url)).toEqual([
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`,
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`,
    ]);
    expect(sockets.map((s) => s.url)).toEqual([`wss://mainnet.helius-rpc.com/?api-key=${HELIUS}`]);
    expect(calls.find((c) => c.url.startsWith('https://api.jup.ag/'))?.headers).toEqual({
      'x-api-key': JUPITER,
    });
    // never /execute, never a POST to Jupiter
    expect(
      calls.filter(
        (c) => c.url.includes('/execute') || (c.url.includes('jup.ag') && c.method !== 'GET'),
      ),
    ).toEqual([]);

    const text = JSON.stringify(report);
    expect(text).not.toContain(HELIUS);
    expect(text).not.toContain(JUPITER);
    expect(text).not.toContain('helius-rpc');
  });

  it('without keys: Helius checks need a key (nothing is sent), Jupiter goes Keyless', async () => {
    const { net, calls, sockets } = network();
    const h = createVaultHandler({ net });
    await fleet(h, {});
    const report = await test(h);
    expect(report.heliusHttp).toEqual({
      ok: false,
      ms: null,
      problem: 'KEY_MISSING',
      httpStatus: null,
      slot: null,
    });
    expect(report.heliusWs).toMatchObject({ ok: false, problem: 'KEY_MISSING' });
    expect(sockets).toEqual([]);
    expect(report.jupiter).toMatchObject({ ok: true, keyless: true });
    expect(calls.map((c) => c.headers)).toEqual([{}]);
  });

  it('custom Helius URLs win over the key', async () => {
    const { net, calls, sockets } = network();
    const h = createVaultHandler({ net });
    await fleet(h, {
      helius: HELIUS,
      heliusRpcUrl: 'https://staked.helius-rpc.com/?api-key=own',
      heliusWsUrl: 'wss://atlas.helius-rpc.com/?api-key=own',
    });
    await test(h);
    expect(calls[0]?.url).toBe('https://staked.helius-rpc.com/?api-key=own');
    expect(sockets[0]?.url).toBe('wss://atlas.helius-rpc.com/?api-key=own');
  });

  it('one failing service does not hide the others', async () => {
    const { net } = network((call) =>
      call.url.startsWith('https://api.jup.ag/')
        ? { status: 401, json: { error: JUPITER } }
        : undefined,
    );
    const h = createVaultHandler({ net });
    await fleet(h, { helius: HELIUS, jupiter: JUPITER });
    const report = await test(h);
    expect(report.heliusHttp.ok).toBe(true);
    expect(report.heliusWs.ok).toBe(true);
    expect(report.jupiter).toMatchObject({ ok: false, problem: 'UNAUTHORIZED', httpStatus: 401 });
    expect(JSON.stringify(report)).not.toContain(JUPITER);
  });

  it('needs an unlocked vault; locking during the test drops the result; lock does not wait', async () => {
    const { net } = network((call) => (call.url.includes('helius') ? 'hang' : undefined));
    const h = createVaultHandler({ net: { ...net, timeoutMs: 50 } });
    expect(await codeOf(test(h))).toBe('VAULT_LOCKED');

    await fleet(h, { helius: HELIUS });
    const running = test(h);
    const locked = await h.handle({ type: 'lock' });
    expect(locked).toMatchObject({ locked: true }); // answered before the 50 ms Helius timeout
    expect(await codeOf(running)).toBe('VAULT_LOCKED');
  });
});
