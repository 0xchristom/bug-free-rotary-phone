/**
 * startBuy / stop in the vault worker (BUNNDLY-21): real vault, real signing, fake
 * Jupiter with real transactions, fake clock. Events carry no secrets.
 */
import { base58 } from '@scure/base';
import type { RpcTransport } from '@solana/kit';
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { AppError, defaultFleetSettings, type FleetSettingsV1 } from '../../src/core/index.ts';
import type { ExecutorEvent, WalletEvent } from '../../src/executor/index.ts';
import type { BuyStatus, VaultPort, VaultStatus } from '../../src/worker/protocol.ts';
import {
  attachVaultHandler,
  createVaultHandler,
  type VaultHandler,
} from '../../src/worker/vault.ts';
import { createVaultClient } from '../../src/worker/vault-client.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter, type FakeJupiterScript } from '../helpers/fake-jupiter.ts';
import { USDC, buildTransaction } from '../helpers/tx-fakes.ts';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX = 10_000_000n;

/** RPC mock: every account has 1 SOL. */
const chain = {
  createTransport: () =>
    ((config: { payload: unknown }) => {
      const payload = config.payload as { id: unknown; params: [string[]] };
      return Promise.resolve({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          context: { slot: 1n },
          value: payload.params[0].map(() => ({
            lamports: 1_000_000_000n,
            owner: '11111111111111111111111111111111',
            data: ['', 'base64'],
            executable: false,
            rentEpoch: 0n,
            space: 0n,
          })),
        },
      });
    }) as unknown as RpcTransport,
  sleep: () => Promise.resolve(),
};

interface Setup {
  readonly dryRun?: boolean;
  readonly script?: FakeJupiterScript;
  readonly refresh?: boolean;
  readonly settings?: Partial<FleetSettingsV1>;
}

async function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const jupiter = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    ...o.script,
  });
  const h = createVaultHandler({
    chain,
    executor: { jupiter, clock },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: ExecutorEvent[] = [];
  h.onEvent((e) => events.push(e));
  await h.handle({
    type: 'create',
    fleetName: 'Zakup',
    walletCount: 3,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  const settings: FleetSettingsV1 = {
    ...base,
    maxSpend: [
      { index: 0, lamports: MAX },
      { index: 1, lamports: MAX },
    ],
    global: { ...base.global, ...(o.dryRun === false ? { dryRun: false } : {}) },
    ...o.settings,
  };
  await h.handle({ type: 'saveSettings', settings, apiKeys: { helius: 'heliusBuyKey' } });
  if (o.refresh !== false) await h.handle({ type: 'refreshBalances' });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  const secrets = (): string[] => {
    const v = h.inspect().unlocked;
    if (!v) return [];
    return [
      new TextDecoder().decode(v.mnemonic),
      ...v.wallets.flatMap((w) => [
        base58.encode(w.secretKey),
        base58.encode(w.secretKey.slice(0, 32)),
      ]),
    ];
  };
  return { clock, jupiter, h, events, status, secrets };
}

const finals = (events: ExecutorEvent[]): WalletEvent[] =>
  events.filter(
    (e): e is WalletEvent =>
      e.kind === 'wallet' && ['CONFIRMED', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(e.state),
  );

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.code : 'other'),
  );
}

describe('startBuy', () => {
  it('DRY-RUN by default: active wallets with max spend sign and skip; zero /execute', async () => {
    const { clock, jupiter, h, events, status } = await setup();
    const started = (await h.handle({ type: 'startBuy', mint: USDC })) as BuyStatus;
    expect(started).toMatchObject({ dryRun: true, wallets: 2, mint: USDC, accepting: true });
    expect(await status()).toMatchObject({ armed: true, buy: { runId: started.runId } });
    await clock.runUntil();
    expect(jupiter.executions()).toHaveLength(0);
    expect(finals(events).map((e) => [e.index, e.state, e.reason?.code])).toEqual([
      [0, 'SKIPPED', 'DRY_RUN'],
      [1, 'SKIPPED', 'DRY_RUN'],
    ]);
    expect(await status()).toMatchObject({ armed: false, buy: null });
  });

  it('live mode: real signatures go to /execute and every wallet is CONFIRMED', async () => {
    const { clock, jupiter, h, events } = await setup({ dryRun: false });
    await h.handle({ type: 'startBuy', mint: USDC });
    await clock.runUntil();
    expect(finals(events).map((e) => e.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    const sent = jupiter.executions();
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      const tx = getTransactionDecoder().decode(
        getBase64Encoder().encode(call.signedTransaction ?? ''),
      );
      expect((tx.signatures as Record<string, unknown>)[call.taker]).not.toBeNull();
    }
  });

  it('wallets without a balance read are skipped before /order', async () => {
    const { clock, jupiter, h, events } = await setup({ refresh: false });
    await h.handle({ type: 'startBuy', mint: USDC });
    await clock.runUntil();
    expect(jupiter.calls).toHaveLength(0);
    expect(finals(events).map((e) => e.reason?.code)).toEqual([
      'BALANCE_UNKNOWN',
      'BALANCE_UNKNOWN',
    ]);
  });

  it('events carry no mnemonic, private key or signed transaction', async () => {
    const { clock, jupiter, h, events, secrets } = await setup({ dryRun: false });
    const held = secrets();
    await h.handle({ type: 'startBuy', mint: USDC });
    await clock.runUntil();
    const text = JSON.stringify(events, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(held.length).toBeGreaterThan(3);
    for (const secret of held) expect(text).not.toContain(secret);
    for (const call of jupiter.executions()) expect(text).not.toContain(call.signedTransaction);
  });

  it('refuses a bad mint, SOL itself, no eligible wallets and a second buy', async () => {
    const { h } = await setup({ settings: { maxSpend: [] } });
    expect(await codeOf(h.handle({ type: 'startBuy', mint: 'not-a-mint' }))).toBe(
      'INVALID_MINT_ADDRESS',
    );
    expect(await codeOf(h.handle({ type: 'startBuy', mint: SOL_MINT }))).toBe(
      'INVALID_MINT_ADDRESS',
    );
    expect(await codeOf(h.handle({ type: 'startBuy', mint: USDC }))).toBe('NO_WALLETS_TO_BUY');

    const busy = await setup();
    await busy.h.handle({ type: 'startBuy', mint: USDC });
    expect(await codeOf(busy.h.handle({ type: 'startBuy', mint: USDC }))).toBe('BUY_RUNNING');
    await busy.clock.runUntil();
  });

  it('armed while running: no auto-lock, no lock, no other fleet; normal again after', async () => {
    const { clock, h, status } = await setup({ script: { orderDelayMs: () => 600_000 } });
    await h.handle({ type: 'startBuy', mint: USDC });
    await clock.runUntil(clock.now() + 300_000);
    expect(h.checkAutoLock()).toBe(false);
    expect(await codeOf(h.handle({ type: 'lock' }))).toBe('BUY_RUNNING');
    expect(await codeOf(h.handle({ type: 'unlock', fileText: '{}', password: PASSWORD }))).toBe(
      'BUY_RUNNING',
    );
    expect((await status()).locked).toBe(false);
    await clock.runUntil();
    expect((await status()).armed).toBe(false);
    expect(await codeOf(h.handle({ type: 'lock' }))).toBe('ok');
  });

  it('stop: no new /order, the status says it is stopping until the run ends', async () => {
    const { clock, jupiter, h, events, status } = await setup({
      dryRun: false,
      script: { orderDelayMs: (c) => (c.taker.length > 0 ? 50 : 0), executeDelayMs: () => 5_000 },
    });
    await h.handle({ type: 'startBuy', mint: USDC });
    await clock.runUntil(clock.now() + 100); // both sent, executing
    const stopped = (await h.handle({ type: 'stop' })) as VaultStatus;
    expect(stopped).toMatchObject({ armed: true, buy: { accepting: false } });
    await clock.runUntil();
    expect(jupiter.calls.filter((c) => c.kind === 'order')).toHaveLength(2);
    expect(finals(events).map((e) => e.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await status()).toMatchObject({ armed: false, buy: null });
  });
});

describe('events over the message port', () => {
  it('the worker pushes executor events without an id; the client delivers them', async () => {
    const clock = new FakeClock();
    const jupiter = new FakeJupiter(clock, {
      transaction: (t) => buildTransaction({ feePayer: t }),
    });
    const handler: VaultHandler = createVaultHandler({ chain, executor: { jupiter, clock } });
    type Listener = (e: { readonly data: unknown }) => void;
    const sides: [Listener[], Listener[]] = [[], []];
    const port = (self: 0 | 1): VaultPort => ({
      postMessage: (m) => {
        const data = structuredClone(m);
        queueMicrotask(() => {
          for (const l of sides[self === 0 ? 1 : 0]) l({ data });
        });
      },
      addEventListener: (_t, l) => {
        sides[self].push(l);
      },
    });
    attachVaultHandler(port(1), handler);
    const client = createVaultClient(port(0));
    const received: ExecutorEvent[] = [];
    const off = client.onEvent((e) => received.push(e));
    await client.request({ type: 'create', fleetName: 'Port', walletCount: 1, password: PASSWORD });
    const base = defaultFleetSettings();
    await client.request({
      type: 'saveSettings',
      settings: { ...base, maxSpend: [{ index: 0, lamports: MAX }] },
      apiKeys: { helius: 'heliusPortKey' },
    });
    await client.request({ type: 'refreshBalances' });
    await client.request({ type: 'startBuy', mint: USDC });
    await clock.runUntil();
    expect(received.map((e) => (e.kind === 'run' ? e.phase : e.state))).toEqual([
      'started',
      'QUEUED',
      'QUOTING',
      'SIGNING',
      'SKIPPED',
      'finished',
    ]);
    off();
  });
});
