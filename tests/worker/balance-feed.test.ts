/**
 * Live balances in the vault worker (BUNNDLY-57, D-055): the feed opens one socket with a
 * subscription per wallet, a notification becomes a `balance` event of its wallet only,
 * locking closes the socket, new wallets get exactly their subscriptions, a switched
 * network drops the old socket, and a landed transaction reads the wallet's token balance
 * at once. Fake WebSocket, fake RPC, fake clock; no network.
 */
import { address, getAddressEncoder, type RpcTransport } from '@solana/kit';
import { base64 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { defaultFleetSettings, type FleetSettingsV1 } from '../../src/core/index.ts';
import type { BalanceEvent, BalanceFeedStatus, WorkerEvent } from '../../src/worker/protocol.ts';
import { TOKEN_READ_GAP_MS, createVaultHandler } from '../../src/worker/vault.ts';
import { FakeChain } from '../helpers/fake-chain.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';
import { MINT_ACCOUNT } from '../helpers/mint-account.ts';
import { USDC, buildTransaction } from '../helpers/tx-fakes.ts';

// The key derivation is not the subject here: the fast stand-in keeps the key bound to
// the password, the salt and the cost (tests/helpers/fast-kdf.ts, BUNNDLY-74).
vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const KEY = 'feedSecretKey123';
const MAINNET_WS = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const DEVNET_WS = `wss://devnet.helius-rpc.com/?api-key=${KEY}`;
/** Token amount every wallet holds after its buy (raw u64). */
const BOUGHT = 4_200_000n;

/** A token account of USDC as getMultipleAccounts returns its first 72 bytes. */
function tokenAccount(amount: bigint) {
  const data = new Uint8Array(72);
  data.set(getAddressEncoder().encode(address(USDC)), 0);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return {
    lamports: 2_039_280n,
    owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    data: [base64.encode(data), 'base64'],
    executable: false,
    rentEpoch: 0n,
    space: 165n,
  };
}

const SYSTEM_ACCOUNT = {
  lamports: 1_000_000_000n,
  owner: '11111111111111111111111111111111',
  data: ['', 'base64'],
  executable: false,
  rentEpoch: 0n,
  space: 0n,
};

interface Setup {
  readonly count?: number;
  readonly heliusKey?: boolean;
  readonly live?: boolean;
  /** A Jupiter key with a high custom limit: 100 buys land in seconds, not minutes. */
  readonly fastJupiter?: boolean;
}

async function setup(o: Setup = {}) {
  const clock = new FakeClock();
  const fakeChain = new FakeChain(clock);
  /** Fake-clock time of every HTTP request to the RPC. */
  const http: number[] = [];
  /** Wallet addresses (owners): their token accounts are ATAs we do not know in advance. */
  let owners = new Set<string>();
  const chain = {
    createTransport: () =>
      ((config: { payload: unknown }) => {
        http.push(clock.now());
        const payload = config.payload as { id: unknown; params: [string[]] };
        return Promise.resolve({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            context: { slot: 1n },
            value: payload.params[0].map((account) =>
              account === USDC
                ? MINT_ACCOUNT
                : owners.has(account)
                  ? SYSTEM_ACCOUNT
                  : tokenAccount(BOUGHT),
            ),
          },
        });
      }) as unknown as RpcTransport,
    sleep: () => Promise.resolve(),
  };
  const jupiter = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    chain: fakeChain,
  });
  const sockets: { url: string; socket: FakeSocket }[] = [];
  const h = createVaultHandler({
    chain,
    net: {
      createWebSocket: (url) => {
        const socket = new FakeSocket(clock.now());
        sockets.push({ url, socket });
        return socket;
      },
    },
    executor: { jupiter, clock, landing: fakeChain.checker, tokens: fakeChain.tokens },
    watch: { random: () => 0.5 },
    now: () => clock.now(),
    autoLockMs: 60 * 60_000,
  });
  const events: WorkerEvent[] = [];
  h.onEvent((e) => events.push(e));
  const count = o.count ?? 3;
  await h.handle({
    type: 'create',
    fleetName: 'Live',
    walletCount: count,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  const settings: FleetSettingsV1 = {
    ...base,
    maxSpend: Array.from({ length: count }, (_, index) => ({ index, lamports: 10_000_000n })),
    global: {
      ...base.global,
      ...(o.live ? { dryRun: false } : {}),
      ...(o.fastJupiter ? { jupiterPlan: 'custom' as const, orderRpm: 6_000 } : {}),
    },
  };
  await h.handle({
    type: 'saveSettings',
    settings,
    ...(o.heliusKey === false
      ? {}
      : { apiKeys: { helius: KEY, ...(o.fastJupiter ? { jupiter: 'jupiterFeedKey' } : {}) } }),
  });
  const addresses = () => h.inspect().unlocked?.publicWallets.map((w) => w.address) ?? [];
  owners = new Set(addresses());
  const balanceEvents = () => events.filter((e): e is BalanceEvent => e.kind === 'balance');
  const sol = () =>
    balanceEvents().filter((e): e is Extract<BalanceEvent, { type: 'sol' }> => e.type === 'sol');
  const last = () => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s.socket;
  };
  const subscribes = (s: FakeSocket) => s.sent.filter((m) => m.method === 'accountSubscribe');
  /** The server confirms every subscription asked for: subscription id = 500 + request id. */
  const confirm = (s: FakeSocket, done = new Set<unknown>()) => {
    for (const m of subscribes(s)) {
      if (done.has(m.id)) continue;
      done.add(m.id);
      s.message({ jsonrpc: '2.0', id: m.id, result: 500 + (m.id as number) });
    }
    return done;
  };
  /** The subscription id the server gave the wallet with this address. */
  const subOf = (s: FakeSocket, addr: string): number => {
    const m = subscribes(s).find((x) => (x.params as unknown[])[0] === addr);
    if (!m) throw new Error(`no subscription for ${addr}`);
    return 500 + (m.id as number);
  };
  const notify = (s: FakeSocket, subscription: number, lamports: number) => {
    s.message({
      jsonrpc: '2.0',
      method: 'accountNotification',
      params: {
        result: {
          context: { slot: 9 },
          value: { ...SYSTEM_ACCOUNT, lamports, rentEpoch: 0, space: 0 },
        },
        subscription,
      },
    });
  };
  const feed = async (on: boolean) =>
    (await h.handle({ type: 'balanceFeed', on })) as BalanceFeedStatus;
  const open = () => sockets.filter((s) => !s.socket.closed).length;
  return {
    clock,
    h,
    http,
    sockets,
    events,
    sol,
    balanceEvents,
    last,
    subscribes,
    confirm,
    subOf,
    notify,
    feed,
    open,
    addresses,
    jupiter,
  };
}

describe('live balance feed in the worker', () => {
  it('one socket, one subscription per wallet; a notification changes only its wallet', async () => {
    const t = await setup({ count: 3 });
    expect(await t.feed(true)).toEqual({ network: 'mainnet', state: 'polling' });
    expect(t.sockets.map((s) => s.url)).toEqual([MAINNET_WS]);
    t.last().open();
    expect(t.subscribes(t.last())).toHaveLength(3);
    t.confirm(t.last());
    expect(t.balanceEvents().filter((e) => e.type === 'feed')).toEqual([
      { kind: 'balance', network: 'mainnet', type: 'feed', state: 'live' },
    ]);
    const [, second] = t.addresses();
    t.notify(t.last(), t.subOf(t.last(), second ?? ''), 3_141_592_653);
    expect(t.sol()).toEqual([
      { kind: 'balance', network: 'mainnet', type: 'sol', index: 1, lamports: 3_141_592_653n },
    ]);
  });

  it('locking closes the socket: no open sockets, nothing more arrives', async () => {
    const t = await setup({ count: 3 });
    await t.feed(true);
    t.last().open();
    t.confirm(t.last());
    expect(t.open()).toBe(1);
    await t.h.handle({ type: 'lock' });
    expect(t.open()).toBe(0);
    const [first] = t.addresses().length > 0 ? t.addresses() : ['x'];
    t.notify(t.last(), 501, 5);
    expect(t.sol()).toEqual([]);
    expect(first).toBeDefined();
  });

  it('two wallets added: exactly two more subscriptions on the same socket', async () => {
    const t = await setup({ count: 3 });
    await t.feed(true);
    t.last().open();
    const done = t.confirm(t.last());
    await t.h.handle({ type: 'addWallets', count: 2 });
    expect(t.sockets).toHaveLength(1);
    const subs = t.subscribes(t.last()).map((m) => (m.params as unknown[])[0]);
    expect(subs).toHaveLength(5);
    expect(subs.slice(3)).toEqual(t.addresses().slice(3));
    t.confirm(t.last(), done);
  });

  it('network guard: after the switch to devnet a late mainnet notification changes nothing', async () => {
    const t = await setup({ count: 2 });
    await t.feed(true);
    const mainnet = t.last();
    mainnet.open();
    t.confirm(mainnet);
    const [first] = t.addresses();
    const sub = t.subOf(mainnet, first ?? '');
    await t.h.handle({ type: 'setNetwork', network: 'devnet' });
    // the old socket is closed and a devnet one opened
    expect(mainnet.closed).toBe(true);
    expect(t.sockets.map((s) => s.url)).toEqual([MAINNET_WS, DEVNET_WS]);
    t.notify(mainnet, sub, 77);
    expect(t.sol()).toEqual([]);
    // the devnet socket works and its events say devnet
    const devnet = t.last();
    devnet.open();
    t.confirm(devnet);
    t.notify(devnet, t.subOf(devnet, first ?? ''), 88);
    expect(t.sol()).toEqual([
      { kind: 'balance', network: 'devnet', type: 'sol', index: 0, lamports: 88n },
    ]);
  });

  it('without a Helius key the feed stays polling and opens no socket', async () => {
    const t = await setup({ heliusKey: false });
    expect(await t.feed(true)).toEqual({ network: 'mainnet', state: 'polling' });
    expect(t.sockets).toHaveLength(0);
  });

  it('feed off closes the socket', async () => {
    const t = await setup();
    await t.feed(true);
    t.last().open();
    await t.feed(false);
    expect(t.open()).toBe(0);
  });
});

describe('token balance after a landed transaction', () => {
  it('each wallet whose buy lands gets its token balance at once, without a poll', async () => {
    const t = await setup({ count: 3, live: true });
    await t.h.handle({ type: 'refreshBalances' });
    const before = t.http.length;
    await t.h.handle({ type: 'startBuy', mint: USDC, wallets: [0, 1, 2] });
    for (let i = 0; i < 200; i++) {
      await t.clock.runUntil(t.clock.now() + 1_000);
      if (t.balanceEvents().filter((e) => e.type === 'token').length >= 3) break;
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    const tokens = t
      .balanceEvents()
      .filter((e): e is Extract<BalanceEvent, { type: 'token' }> => e.type === 'token');
    expect(tokens.map((e) => [e.index, e.amount, e.mint]).sort()).toEqual([
      [0, BOUGHT, USDC],
      [1, BOUGHT, USDC],
      [2, BOUGHT, USDC],
    ]);
    expect(t.http.length).toBeGreaterThan(before);
  });

  it('100 wallets: reads stay at most 10 HTTP requests to the RPC in any second', async () => {
    const t = await setup({ count: 100, live: true, fastJupiter: true });
    await t.feed(true);
    t.last().open();
    t.confirm(t.last());
    await t.h.handle({ type: 'refreshBalances' });
    const start = t.clock.now();
    await t.h.handle({
      type: 'startBuy',
      mint: USDC,
      wallets: Array.from({ length: 100 }, (_, i) => i),
    });
    // What use-balances.ts does: a full read every 30 s while live, every 12 s while
    // polling, and one right away when the feed comes back. The socket drops at 3 s.
    const feedState = () =>
      t
        .balanceEvents()
        .filter((e) => e.type === 'feed')
        .at(-1)?.type === 'feed'
        ? (
            t
              .balanceEvents()
              .filter((e) => e.type === 'feed')
              .at(-1) as { state: string }
          ).state
        : 'polling';
    let nextPoll = start + 30_000;
    let shown = feedState();
    let dropped = false;
    for (let i = 0; i < 300; i++) {
      await t.clock.runUntil(t.clock.now() + 1_000);
      if (!dropped && t.clock.now() >= start + 3_000) {
        dropped = true;
        t.last().fire('close'); // the server drops the socket; it comes back after backoff
      }
      if (t.sockets.length === 2 && !t.last().closed && t.subscribes(t.last()).length === 0) {
        t.last().open();
        t.confirm(t.last());
      }
      const state = feedState();
      if (state !== shown) {
        shown = state;
        nextPoll = t.clock.now() + (state === 'live' ? 30_000 : 12_000);
        if (state === 'live') await t.h.handle({ type: 'refreshBalances' }); // reconcile
      }
      if (t.clock.now() >= nextPoll) {
        nextPoll += shown === 'live' ? 30_000 : 12_000;
        await t.h.handle({ type: 'refreshBalances' });
      }
      const landed = t.balanceEvents().filter((e) => e.type === 'token').length >= 100;
      if (landed && dropped && shown === 'live') break;
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    expect(dropped).toBe(true);
    expect(shown).toBe('live');
    expect(t.balanceEvents().filter((e) => e.type === 'token')).toHaveLength(100);
    const perSecond = new Map<number, number>();
    for (const at of t.http.filter((x) => x >= start)) {
      const second = Math.floor((at - start) / 1_000);
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    }
    expect(Math.max(...perSecond.values())).toBeLessThanOrEqual(10);
    expect(TOKEN_READ_GAP_MS).toBeGreaterThanOrEqual(1_000);
  });
});
