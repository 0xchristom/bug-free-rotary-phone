import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, defaultFleetSettings, isAppError } from '../../src/core/index.ts';
import type { VaultPort } from '../../src/worker/protocol.ts';
import {
  attachVaultHandler,
  createVaultHandler,
  type VaultHandler,
} from '../../src/worker/vault.ts';
import {
  DEFAULT_SLOW_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  createVaultClient,
} from '../../src/worker/vault-client.ts';

type Listener = (event: { readonly data: unknown }) => void;

/** In-memory port pair; messages are structured-cloned like a real postMessage. */
function portPair(): [VaultPort, VaultPort] {
  const listeners: [Listener[], Listener[]] = [[], []];
  const make = (self: 0 | 1): VaultPort => ({
    postMessage: (message) => {
      const data = structuredClone(message);
      queueMicrotask(() => {
        for (const l of listeners[self === 0 ? 1 : 0]) l({ data });
      });
    },
    addEventListener: (_type, listener) => {
      listeners[self].push(listener);
    },
  });
  return [make(0), make(1)];
}

/** A port whose other side never answers; records what was sent. */
function silentPort(): VaultPort & { sent: unknown[]; reply: (data: unknown) => void } {
  const listeners: Listener[] = [];
  const sent: unknown[] = [];
  return {
    sent,
    postMessage: (m) => sent.push(m),
    addEventListener: (_t, l) => listeners.push(l),
    reply: (data) => {
      for (const l of listeners) l({ data });
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('vault client ↔ handler', () => {
  it('round-trips a request and rebuilds worker errors as AppError with the same code', async () => {
    const [ui, worker] = portPair();
    attachVaultHandler(worker, createVaultHandler());
    const client = createVaultClient(ui);

    expect(await client.request({ type: 'status' })).toEqual({
      locked: true,
      armed: false,
      info: null,
      buy: null,
    });
    const err = await rejection(client.request({ type: 'addWallets', count: 1 }));
    expect(err).toBeInstanceOf(AppError);
    expect(isAppError(err) && err.code).toBe('VAULT_LOCKED');
    expect((err as AppError).message).toContain('zablokowany');
  });

  it('unknown worker errors arrive as INTERNAL_ERROR without their content', async () => {
    const [ui, worker] = portPair();
    const throwing: VaultHandler = {
      ...createVaultHandler(),
      handle: () => Promise.reject(new Error('abandon abandon secret details')),
    };
    attachVaultHandler(worker, throwing);
    const err = await rejection(createVaultClient(ui).request({ type: 'status' }));
    expect(isAppError(err) && err.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('abandon');
  });

  it('an unknown code from the port becomes INTERNAL_ERROR', async () => {
    const port = silentPort();
    const pending = createVaultClient(port).request({ type: 'status' });
    port.reply({ id: 1, ok: false, code: 'NOT_A_REAL_CODE' });
    const err = await rejection(pending);
    expect(isAppError(err) && err.code).toBe('INTERNAL_ERROR');
  });

  it('works over a real MessageChannel (structured clone, bigint settings)', async () => {
    const channel = new MessageChannel();
    try {
      attachVaultHandler(channel.port2 as unknown as VaultPort, createVaultHandler());
      const client = createVaultClient(channel.port1 as unknown as VaultPort);
      const status = await client.request({ type: 'stop' });
      expect(status).toMatchObject({ armed: false, buy: null });
      const err = await rejection(
        client.request({
          type: 'saveSettings',
          settings: { ...defaultFleetSettings(), maxSpend: [{ index: 0, lamports: 1n }] },
          apiKeys: {},
        }),
      );
      expect(isAppError(err) && err.code).toBe('VAULT_LOCKED');
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});

describe('progress', () => {
  it('reports scrypt progress of create in whole percent, ending at 1', async () => {
    const [ui, worker] = portPair();
    attachVaultHandler(worker, createVaultHandler());
    const client = createVaultClient(ui);
    const seen: number[] = [];
    const result = await client.request(
      {
        type: 'create',
        fleetName: 'Postep',
        walletCount: 1,
        password: 'correct horse battery staple',
      },
      { onProgress: (p) => seen.push(p) },
    );
    expect(result.info.wallets).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.length).toBeLessThanOrEqual(101);
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((p, i) => i === 0 || p > (seen[i - 1] ?? -1))).toBe(true);
    expect(seen.every((p) => Number.isInteger(Math.round(p * 100)) && p >= 0 && p <= 1)).toBe(true);
  }, 60_000);

  it('ignores progress for unknown ids and does not settle the request', async () => {
    const port = silentPort();
    const client = createVaultClient(port);
    let settled = false;
    const pending = client.request({ type: 'status' }).finally(() => (settled = true));
    port.reply({ id: 99, progress: 0.5 });
    port.reply({ id: 1, progress: 0.5 });
    await Promise.resolve();
    expect(settled).toBe(false);
    port.reply({ id: 1, ok: true, result: { locked: true, armed: false, info: null } });
    await pending;
  });
});

describe('worker failure', () => {
  it('rejects all pending requests at once with INTERNAL_ERROR', async () => {
    vi.useFakeTimers();
    const port = silentPort();
    let fail: (() => void) | undefined;
    const client = createVaultClient({
      ...port,
      addFailureListener: (listener) => {
        fail = listener;
      },
    });
    const a = rejection(client.request({ type: 'status' }));
    const b = rejection(client.request({ type: 'unlock', fileText: '{}', password: 'x' }));
    expect(fail).toBeDefined();
    fail?.();
    // no timer advanced: both settle immediately
    const [ea, eb] = await Promise.all([a, b]);
    expect(isAppError(ea) && ea.code).toBe('INTERNAL_ERROR');
    expect(isAppError(eb) && eb.code).toBe('INTERNAL_ERROR');
    // timers were cleared, so nothing fires later
    await vi.advanceTimersByTimeAsync(DEFAULT_SLOW_TIMEOUT_MS);
    // later requests still go out
    const c = client.request({ type: 'status' });
    port.reply({ id: 3, ok: true, result: { locked: true, armed: false, info: null } });
    expect(await c).toEqual({ locked: true, armed: false, info: null });
  });
});

describe('timeouts', () => {
  it('no reply ends with VAULT_TIMEOUT after the default timeout', async () => {
    vi.useFakeTimers();
    const port = silentPort();
    const pending = rejection(createVaultClient(port).request({ type: 'status' }));
    expect(port.sent).toEqual([{ id: 1, request: { type: 'status' } }]);
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(isAppError(err) && err.code).toBe('VAULT_TIMEOUT');
    expect((err as AppError).message).toContain('nie odpowiedział');
  });

  it('create and unlock get the longer timeout (scrypt)', async () => {
    vi.useFakeTimers();
    const port = silentPort();
    const client = createVaultClient(port);
    let settled = false;
    const pending = rejection(
      client.request({ type: 'unlock', fileText: '{}', password: 'x' }),
    ).then((e) => {
      settled = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_SLOW_TIMEOUT_MS - DEFAULT_TIMEOUT_MS);
    expect(isAppError(await pending) && ((await pending) as AppError).code).toBe('VAULT_TIMEOUT');
  });

  it('ignores a late reply after a timeout and keeps serving new requests', async () => {
    vi.useFakeTimers();
    const port = silentPort();
    const client = createVaultClient(port, { timeoutMs: 100 });
    const first = rejection(client.request({ type: 'status' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(isAppError(await first)).toBe(true);
    port.reply({ id: 1, ok: true, result: { locked: true } }); // late, ignored
    const second = client.request({ type: 'status' });
    port.reply({ id: 2, ok: true, result: { locked: false, armed: false, info: null } });
    expect(await second).toEqual({ locked: false, armed: false, info: null });
  });
});
