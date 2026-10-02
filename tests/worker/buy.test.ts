/**
 * startBuy / stop in the vault worker (BUNNDLY-21): real vault, real signing, fake
 * Jupiter with real transactions, fake clock. Events carry no secrets.
 */
import { base58 } from '@scure/base';
import type { RpcTransport } from '@solana/kit';
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import { AppError, defaultFleetSettings, type FleetSettingsV1 } from '../../src/core/index.ts';
import {
  logEntry,
  toCsv,
  toJson,
  type ExecutorEvent,
  type VerifyEvent,
  type WalletEvent,
} from '../../src/executor/index.ts';
import type { BuyStatus, VaultPort, VaultStatus } from '../../src/worker/protocol.ts';
import {
  attachVaultHandler,
  createVaultHandler,
  type VaultHandler,
} from '../../src/worker/vault.ts';
import { createVaultClient } from '../../src/worker/vault-client.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
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
  readonly withChain?: boolean;
  readonly heliusKey?: boolean;
  readonly walletCount?: number;
  readonly jupiterKey?: boolean;
}

async function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const fakeChain = new FakeChain(clock);
  const jupiter = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    ...(o.withChain ? { chain: fakeChain } : {}),
    ...o.script,
  });
  const h = createVaultHandler({
    chain,
    executor: {
      jupiter,
      clock,
      ...(o.withChain ? { landing: fakeChain.checker, tokens: fakeChain.tokens } : {}),
    },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: ExecutorEvent[] = [];
  h.onEvent((e) => events.push(e));
  await h.handle({
    type: 'create',
    fleetName: 'Zakup',
    walletCount: o.walletCount ?? 3,
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
  await h.handle({
    type: 'saveSettings',
    settings,
    ...(o.heliusKey === false
      ? {}
      : {
          apiKeys: {
            helius: 'heliusBuyKey',
            ...(o.jupiterKey ? { jupiter: 'jupiterBuyKey' } : {}),
          },
        }),
  });
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
  return { clock, jupiter, fakeChain, h, events, status, secrets };
}

const finals = (events: ExecutorEvent[]): WalletEvent[] =>
  events.filter(
    (e): e is WalletEvent =>
      e.kind === 'wallet' &&
      ['CONFIRMED', 'FAILED', 'UNKNOWN', 'SKIPPED'].includes(e.state) &&
      // UNKNOWN while the chain is checked is not final
      e.reason?.code !== 'EXECUTE_NO_ANSWER',
  );

/**
 * Runs the fake clock until the run's `finished` event. The vault signs with real
 * WebCrypto, which completes on a thread pool: under load it can need more real time
 * than the clock's settle turns, so wait for the event instead of counting turns.
 */
async function runToEnd(clock: FakeClock, events: readonly ExecutorEvent[]): Promise<void> {
  const finished = () => events.some((e) => e.kind === 'run' && e.phase === 'finished');
  for (let i = 0; i < 400 && !finished(); i++) {
    await clock.runUntil();
    if (!finished()) {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
  if (!finished()) throw new Error('the run did not finish');
}

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
    await runToEnd(clock, events);
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
    await runToEnd(clock, events);
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

  it('live mode needs the Helius key for the chain check; DRY-RUN does not', async () => {
    const live = await setup({ dryRun: false, refresh: false, heliusKey: false });
    expect(await codeOf(live.h.handle({ type: 'startBuy', mint: USDC }))).toBe(
      'HELIUS_KEY_MISSING',
    );
    const dry = await setup({ refresh: false, heliusKey: false });
    expect(await codeOf(dry.h.handle({ type: 'startBuy', mint: USDC }))).toBe('ok');
    await runToEnd(dry.clock, dry.events);
  });

  it('timeout after a real signed send that landed: the chain check confirms, one buy', async () => {
    const { clock, jupiter, fakeChain, h, events } = await setup({
      dryRun: false,
      withChain: true,
      script: { execute: () => ({ fail: 'TIMEOUT', lands: { afterMs: 1_000 } }) },
    });
    await h.handle({ type: 'startBuy', mint: USDC });
    await runToEnd(clock, events);
    expect(finals(events).map((e) => e.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(jupiter.calls.filter((c) => c.kind === 'order')).toHaveLength(2);
    const takers = new Set(jupiter.executions().map((c) => c.taker));
    for (const taker of takers) expect(fakeChain.successfulBuys(taker)).toHaveLength(1);
  });

  it('after CONFIRMED the token balance confirms the buy (verify events, live only)', async () => {
    const { clock, h, events } = await setup({
      dryRun: false,
      withChain: true,
      script: { executeDelayMs: () => 1_000 },
    });
    await h.handle({ type: 'startBuy', mint: USDC });
    await runToEnd(clock, events);
    const verify = (): VerifyEvent[] => events.filter((e): e is VerifyEvent => e.kind === 'verify');
    for (let i = 0; i < 100 && verify().length < 2; i++) await clock.runUntil();
    expect(verify().map((e) => [e.index, e.status, e.observed === e.expected])).toEqual([
      [0, 'MATCH', true],
      [1, 'MATCH', true],
    ]);

    const dry = await setup({ withChain: true });
    await dry.h.handle({ type: 'startBuy', mint: USDC });
    await runToEnd(dry.clock, dry.events);
    expect(dry.events.filter((e) => e.kind === 'verify')).toHaveLength(0);
  });

  it('the exported log (CSV and JSON) has no mnemonic, keys, API key or signed transaction', async () => {
    const { clock, jupiter, h, events, secrets } = await setup({
      dryRun: false,
      withChain: true,
      script: {
        execute: (c) => (c.nth === 1 ? { fail: 'TIMEOUT', lands: { afterMs: 500 } } : 'ok'),
      },
    });
    const held = secrets();
    await h.handle({ type: 'startBuy', mint: USDC });
    await runToEnd(clock, events);
    const addresses = ((await h.handle({ type: 'status' })) as VaultStatus).info?.wallets ?? [];
    const entries = events.map((e) =>
      logEntry(e, {
        addressOf: (i) => addresses.find((w) => w.index === i)?.address ?? null,
        decimals: 6,
      }),
    );
    for (const text of [toCsv(entries), toJson(entries)]) {
      expect(text).toContain('CONFIRMED');
      expect(text).toContain(addresses[0]?.address);
      for (const secret of held) expect(text).not.toContain(secret);
      expect(text).not.toContain('heliusBuyKey');
      expect(text.toLowerCase()).not.toContain('api-key');
      for (const call of jupiter.executions()) {
        expect(text).not.toContain(call.signedTransaction);
      }
    }
  });

  it('without a Jupiter key the Keyless limits apply, whatever plan the settings name', async () => {
    const thirty = {
      maxSpend: Array.from({ length: 30 }, (_, index) => ({ index, lamports: MAX })),
    };
    const startsAtOnce = async (jupiterKey: boolean): Promise<number> => {
      const t = await setup({ walletCount: 30, jupiterKey, settings: thirty });
      const global = (await t.status()).info?.settings.global;
      expect(global?.jupiterPlan).toBe('free'); // default plan in the settings
      await t.h.handle({ type: 'startBuy', mint: USDC });
      await runToEnd(t.clock, t.events);
      const first = t.jupiter.calls.filter((c) => c.kind === 'order').map((c) => c.start);
      return first.filter((at) => at === Math.min(...first)).length;
    };
    expect(await startsAtOnce(false)).toBe(27); // Keyless budget: 90 % of 30 per minute
    expect(await startsAtOnce(true)).toBe(30); // Free with a key: 54, all 30 at once
  });

  it('wallets without a balance read are skipped before /order', async () => {
    const { clock, jupiter, h, events } = await setup({ refresh: false });
    await h.handle({ type: 'startBuy', mint: USDC });
    await runToEnd(clock, events);
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
    await runToEnd(clock, events);
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
    await runToEnd(busy.clock, busy.events);
  });

  it('armed while running: no auto-lock, no lock, no other fleet; normal again after', async () => {
    const { clock, h, events, status } = await setup({
      script: { orderDelayMs: () => 600_000 },
    });
    await h.handle({ type: 'startBuy', mint: USDC });
    await clock.runUntil(clock.now() + 300_000);
    expect(h.checkAutoLock()).toBe(false);
    expect(await codeOf(h.handle({ type: 'lock' }))).toBe('BUY_RUNNING');
    expect(await codeOf(h.handle({ type: 'unlock', fileText: '{}', password: PASSWORD }))).toBe(
      'BUY_RUNNING',
    );
    expect((await status()).locked).toBe(false);
    await runToEnd(clock, events);
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
    await runToEnd(clock, events);
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
    await runToEnd(clock, received);
    expect(
      received.map((e) => (e.kind === 'run' ? e.phase : e.kind === 'wallet' ? e.state : e.status)),
    ).toEqual(['started', 'QUEUED', 'QUOTING', 'SIGNING', 'SKIPPED', 'finished']);
    off();
  });
});
