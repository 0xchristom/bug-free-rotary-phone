/**
 * The fleet's network in the vault worker (BUNNDLY-44, D-041): where the reads go after a
 * switch, what devnet refuses and that nothing reaches Jupiter there. Real vault, mock
 * transports and sockets; the expected hosts are the documented ones (tests/core/network).
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  defaultFleetSettings,
  type ConnectionReport,
  type FleetSettingsV1,
} from '../../src/core/index.ts';
import type { ExecutorEvent } from '../../src/executor/executor.ts';
import type {
  BuyStatus,
  VaultBalances,
  VaultFileResult,
  VaultStatus,
} from '../../src/worker/protocol.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import { MINT_ACCOUNT } from '../helpers/mint-account.ts';
import {
  FakeSocket,
  QUOTE_BODY,
  fakeFetch,
  heliusSocket,
  stepClock,
} from '../helpers/net-fakes.ts';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const KEY = 'heliusNetworkKey42';
const CREATOR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Every wallet of the open fleet: what "select all" in the table sends (BUNNDLY-59). */
const all = (h: VaultHandler): number[] =>
  h.inspect().unlocked?.publicWallets.map((w) => w.index) ?? [];
const MAINNET_HELIUS = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const DEVNET_HELIUS = `https://devnet.helius-rpc.com/?api-key=${KEY}`;
const MAINNET_PUBLIC = 'https://api.mainnet.solana.com';
const DEVNET_PUBLIC = 'https://api.devnet.solana.com';

interface Payload {
  readonly id: unknown;
  readonly params: [string[], unknown];
}

/** Lamports of each wallet, in fleet order, on each network. */
interface PerNetwork {
  readonly mainnet: readonly bigint[];
  readonly devnet: readonly bigint[];
}

/**
 * Mock RPC: records the URL of every request; `down` hosts fail like a network error.
 * Every account holds 2 SOL unless `perNetwork` gives each network its own balances.
 */
function world(down: readonly string[] = [], perNetwork?: PerNetwork) {
  const rpcUrls: string[] = [];
  const events: ExecutorEvent[] = [];
  let hold: Promise<void> | null = null;
  const sockets: FakeSocket[] = [];
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.startsWith('https://api.jup.ag/')) return { status: 200, json: QUOTE_BODY };
    const body = call.body as { id: number; method: string };
    return {
      status: 200,
      json: { jsonrpc: '2.0', id: body.id, result: body.method === 'getHealth' ? 'ok' : 77 },
    };
  });
  const h = createVaultHandler({
    chain: {
      createTransport: (url) =>
        (async (config: { payload: unknown }) => {
          rpcUrls.push(url);
          if (down.includes(url)) throw new TypeError('fetch failed');
          if (hold) await hold;
          const payload = config.payload as Payload;
          return {
            jsonrpc: '2.0',
            id: payload.id,
            result: {
              context: { slot: 1n },
              value: payload.params[0].map((address, i) =>
                address === MINT
                  ? MINT_ACCOUNT
                  : {
                      lamports:
                        perNetwork === undefined
                          ? 2_000_000_000n
                          : (perNetwork[url.includes('devnet') ? 'devnet' : 'mainnet'][i] ?? 0n),
                      owner: '11111111111111111111111111111111',
                      data: ['', 'base64'],
                      executable: false,
                      rentEpoch: 0n,
                      space: 0n,
                    },
              ),
            },
          };
        }) as unknown as RpcTransport,
      sleep: () => Promise.resolve(),
    },
    net: {
      fetch,
      createWebSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => {
          heliusSocket(socket);
        });
        return socket;
      },
      timeoutMs: 1000,
      clock: stepClock(),
    },
  });
  h.onEvent((e) => {
    if (e.kind !== 'watch') events.push(e);
  });
  return {
    h,
    rpcUrls,
    sockets,
    events,
    /** Every HTTP request of the connection test and of the real Jupiter client. */
    fetchCalls: calls,
    jupiterCalls: () => calls.filter((c) => c.url.includes('jup.ag')),
    /** Makes RPC answers wait until the returned function is called. */
    holdRpc: (): (() => void) => {
      let release: () => void = () => undefined;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        hold = null;
        release();
      };
    },
  };
}

function settingsWith(global: Partial<FleetSettingsV1['global']> = {}): FleetSettingsV1 {
  const base = defaultFleetSettings();
  return {
    ...base,
    maxSpend: [{ index: 0, lamports: 10_000_000n }],
    global: { ...base.global, ...global },
  };
}

async function fleet(
  h: VaultHandler,
  apiKeys: Record<string, string> = { helius: KEY },
): Promise<string> {
  const created = (await h.handle({
    type: 'create',
    fleetName: 'Sieci',
    walletCount: 2,
    password: PASSWORD,
  })) as VaultFileResult;
  await h.handle({ type: 'saveSettings', settings: settingsWith(), apiKeys });
  return created.fileText;
}

const status = async (h: VaultHandler) => (await h.handle({ type: 'status' })) as VaultStatus;
const refresh = async (h: VaultHandler) =>
  (await h.handle({ type: 'refreshBalances' })) as VaultBalances;
const toDevnet = async (h: VaultHandler) =>
  (await h.handle({ type: 'setNetwork', network: 'devnet' })) as VaultFileResult;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.code : 'not an AppError'),
  );
}

describe('the saved network', () => {
  it('a new fleet is on mainnet; the switch is in the status and in the saved file', async () => {
    const w = world();
    const oldFile = await fleet(w.h);
    expect((await status(w.h)).network).toBe('mainnet');
    expect((await status(w.h)).info?.settings.global.network).toBe('mainnet');

    const saved = await toDevnet(w.h);
    expect((await status(w.h)).network).toBe('devnet');
    expect(saved.info.settings.global.network).toBe('devnet');

    // The new file opens on devnet; the file from before the switch still opens on mainnet.
    const other = createVaultHandler();
    const reopened = (await other.handle({
      type: 'unlock',
      fileText: saved.fileText,
      password: PASSWORD,
    })) as VaultStatus;
    expect(reopened.network).toBe('devnet');
    const old = (await other.handle({
      type: 'unlock',
      fileText: oldFile,
      password: PASSWORD,
    })) as VaultStatus;
    expect(old.network).toBe('mainnet');
    // A locked vault reads nothing: it reports the default.
    expect(((await other.handle({ type: 'lock' })) as VaultStatus).network).toBe('mainnet');
  });

  it('refuses an unknown network, a locked vault and settings without a known network', async () => {
    const w = world();
    expect(await codeOf(w.h.handle({ type: 'setNetwork', network: 'devnet' }))).toBe(
      'VAULT_LOCKED',
    );
    await fleet(w.h);
    for (const network of ['testnet', 'Devnet', '', null, undefined, 1]) {
      expect(await codeOf(w.h.handle({ type: 'setNetwork', network }))).toBe('INTERNAL_ERROR');
    }
    const withoutNetwork: Record<string, unknown> = { ...settingsWith().global };
    delete withoutNetwork.network;
    for (const global of [withoutNetwork, { ...withoutNetwork, network: 'testnet' }]) {
      expect(
        await codeOf(w.h.handle({ type: 'saveSettings', settings: { ...settingsWith(), global } })),
      ).toBe('INVALID_SETTINGS');
    }
    expect((await status(w.h)).network).toBe('mainnet');
  });
});

describe('reads after the switch', () => {
  it('the next balance read goes to the devnet Helius host', async () => {
    const w = world();
    await fleet(w.h);
    expect((await refresh(w.h)).network).toBe('mainnet');
    expect(w.rpcUrls).toEqual([MAINNET_HELIUS]);

    await toDevnet(w.h);
    const res = await refresh(w.h);
    expect(res.network).toBe('devnet');
    expect(res.source).toBe('helius');
    expect(w.rpcUrls).toEqual([MAINNET_HELIUS, DEVNET_HELIUS]);

    await w.h.handle({ type: 'setNetwork', network: 'mainnet' });
    await refresh(w.h);
    expect(w.rpcUrls.at(-1)).toBe(MAINNET_HELIUS);
  });

  it('with Helius down the fallback is the public RPC of the same network', async () => {
    const w = world([MAINNET_HELIUS, DEVNET_HELIUS]);
    await fleet(w.h);
    expect((await refresh(w.h)).source).toBe('fallback');
    expect(w.rpcUrls.at(-1)).toBe(MAINNET_PUBLIC);

    await toDevnet(w.h);
    w.rpcUrls.length = 0;
    const res = await refresh(w.h);
    expect(res).toMatchObject({ network: 'devnet', source: 'fallback' });
    expect(new Set(w.rpcUrls)).toEqual(new Set([DEVNET_HELIUS, DEVNET_PUBLIC]));
    expect(w.rpcUrls.at(-1)).toBe(DEVNET_PUBLIC);
  });

  it('a read still in flight at the switch is labelled with the network it came from', async () => {
    const w = world();
    await fleet(w.h);
    const release = w.holdRpc();
    const inFlight = refresh(w.h);
    await toDevnet(w.h);
    release();
    expect((await inFlight).network).toBe('mainnet');
    expect((await refresh(w.h)).network).toBe('devnet');
  });

  it('a custom endpoint serves only the network its host names', async () => {
    const customMainnet = 'https://staked.helius-rpc.com/?api-key=own';
    const w = world();
    await fleet(w.h, { helius: KEY, heliusRpcUrl: customMainnet });
    await refresh(w.h);
    expect(w.rpcUrls).toEqual([customMainnet]);
    await toDevnet(w.h);
    await refresh(w.h);
    expect(w.rpcUrls).toEqual([customMainnet, DEVNET_HELIUS]);

    // Only a custom mainnet address and no key: devnet has no Helius address at all.
    const noKey = world();
    await fleet(noKey.h, { heliusRpcUrl: customMainnet });
    await toDevnet(noKey.h);
    expect(await codeOf(refresh(noKey.h))).toBe('HELIUS_KEY_MISSING');
    expect(noKey.rpcUrls).toEqual([]);

    // A custom devnet address is used on devnet and ignored on mainnet.
    const customDevnet = 'https://devnet.helius-rpc.com/?api-key=own';
    const dev = world();
    await fleet(dev.h, { helius: KEY, heliusRpcUrl: customDevnet });
    await refresh(dev.h);
    await toDevnet(dev.h);
    await refresh(dev.h);
    expect(dev.rpcUrls).toEqual([MAINNET_HELIUS, customDevnet]);
  });
});

/**
 * Money path: the pre-check before `/order` compares the wallet's balance with max spend
 * plus the reserve. The balances are written by hand and differ on each network, so every
 * wallet's outcome says which network's balance was used. Each wallet needs
 * 0.01 SOL (max spend) + 0.015 SOL (default reserve) = 25_000_000 lamports:
 *
 *   wallet 0: devnet 2 SOL (enough),  mainnet 0.02 SOL (5_000_000 short)
 *   wallet 1: devnet 0 (nothing),     mainnet 0.03 SOL (enough)
 */
const BALANCES: PerNetwork = {
  devnet: [2_000_000_000n, 0n],
  mainnet: [20_000_000n, 30_000_000n],
};
const MAX_SPEND = 10_000_000n;

function spendBoth(network: 'mainnet' | 'devnet'): FleetSettingsV1 {
  return {
    ...settingsWith({ network }),
    maxSpend: [
      { index: 0, lamports: MAX_SPEND },
      { index: 1, lamports: MAX_SPEND },
    ],
  };
}

/** The two ways the vault changes the network: the header switch and saved settings. */
const SWITCH = {
  setNetwork: (h: VaultHandler, network: 'mainnet' | 'devnet') =>
    h.handle({ type: 'setNetwork', network }),
  saveSettings: (h: VaultHandler, network: 'mainnet' | 'devnet') =>
    h.handle({ type: 'saveSettings', settings: spendBoth(network) }),
};

type World = ReturnType<typeof world>;

async function moneyFleet(w: World): Promise<string[]> {
  await fleet(w.h);
  await w.h.handle({ type: 'saveSettings', settings: spendBoth('mainnet') });
  expect((await status(w.h)).info?.settings.global.minReserveLamports).toBe(15_000_000n);
  return ((await status(w.h)).info?.wallets ?? []).map((wallet) => wallet.address);
}

/**
 * Starts a buy and returns what the pre-check decided for each wallet, by wallet index:
 * `QUEUED` (on to `/order`) or the reason it was skipped. Then stops the run.
 */
async function preCheck(w: World): Promise<string[]> {
  const { runId } = (await w.h.handle({
    type: 'startBuy',
    mint: MINT,
    wallets: all(w.h),
  })) as BuyStatus;
  const decided = (): string[] => {
    const first = new Map<number, string>();
    for (const e of w.events) {
      if (e.kind !== 'wallet' || e.runId !== runId || first.has(e.index)) continue;
      if (e.state === 'QUEUED') first.set(e.index, 'QUEUED');
      else if (e.state === 'SKIPPED') first.set(e.index, e.reason?.code ?? 'no reason');
    }
    return [0, 1].map((index) => first.get(index) ?? 'undecided');
  };
  await vi.waitFor(() => {
    expect(decided()).not.toContain('undecided');
  });
  const result = decided();
  if ((await status(w.h)).buy !== null) await w.h.handle({ type: 'stop' });
  await vi.waitFor(async () => {
    expect((await status(w.h)).buy).toBeNull();
  });
  return result;
}

const lamportsOf = (res: VaultBalances): bigint[] => res.balances.map((b) => b.lamports);
const orderTakers = (w: World): (string | null)[] =>
  w
    .jupiterCalls()
    .filter((c) => c.url.includes('/order'))
    .map((c) => new URL(c.url).searchParams.get('taker'));

describe('balances of one network never pay for a buy on the other', () => {
  it.each(['setNetwork', 'saveSettings'] as const)(
    'after %s back to mainnet the devnet balances are gone: no wallet is pre-checked with them',
    async (route) => {
      const w = world([], BALANCES);
      const [, second] = await moneyFleet(w);
      await SWITCH[route](w.h, 'devnet');
      expect(lamportsOf(await refresh(w.h))).toEqual([2_000_000_000n, 0n]);
      await SWITCH[route](w.h, 'mainnet');
      expect((await status(w.h)).network).toBe('mainnet');

      // Nothing read on mainnet yet. With the devnet balances wallet 0 would be queued.
      expect(await preCheck(w)).toEqual(['BALANCE_UNKNOWN', 'BALANCE_UNKNOWN']);
      expect(w.jupiterCalls()).toEqual([]);

      // A fresh read on mainnet: 0.02 SOL is 5_000_000 short of 0.025, 0.03 SOL is enough.
      expect(lamportsOf(await refresh(w.h))).toEqual([20_000_000n, 30_000_000n]);
      expect(await preCheck(w)).toEqual(['INSUFFICIENT_SOL', 'QUEUED']);
      const takers = orderTakers(w);
      expect(takers.length).toBeGreaterThan(0);
      expect(new Set(takers)).toEqual(new Set([second]));
    },
  );

  it('a devnet read that lands after the switch back is not the mainnet pre-check balance', async () => {
    const w = world([], BALANCES);
    await moneyFleet(w);
    await toDevnet(w.h);
    const release = w.holdRpc();
    const inFlight = refresh(w.h);
    await w.h.handle({ type: 'setNetwork', network: 'mainnet' });
    release();
    const late = await inFlight;
    // The answer is honest about where it was read and what it found there.
    expect(late.network).toBe('devnet');
    expect(lamportsOf(late)).toEqual([2_000_000_000n, 0n]);

    // With that answer kept, wallet 0 (2 SOL on devnet) would be queued for `/order`.
    expect(await preCheck(w)).toEqual(['BALANCE_UNKNOWN', 'BALANCE_UNKNOWN']);
    expect(w.jupiterCalls()).toEqual([]);
  });
});

describe('devnet has no buy route', () => {
  it('startBuy, arm and the connection test send nothing to Jupiter', async () => {
    const w = world();
    await fleet(w.h);
    await toDevnet(w.h);
    await refresh(w.h);

    expect(await codeOf(w.h.handle({ type: 'startBuy', mint: MINT, wallets: all(w.h) }))).toBe(
      'NO_BUY_ROUTE_ON_NETWORK',
    );
    expect(await codeOf(w.h.handle({ type: 'arm', creator: CREATOR, wallets: all(w.h) }))).toBe(
      'NO_BUY_ROUTE_ON_NETWORK',
    );
    expect(await status(w.h)).toMatchObject({ armed: false, buy: null, watch: null });

    const report = (await w.h.handle({ type: 'testConnections' })) as ConnectionReport;
    expect(report.network).toBe('devnet');
    expect(report.jupiter).toBeNull();
    expect(report.heliusHttp.ok).toBe(true);
    expect(report.heliusWs.ok).toBe(true);
    expect(w.fetchCalls.map((c) => c.url)).toEqual([DEVNET_HELIUS, DEVNET_HELIUS]);
    expect(w.sockets.map((s) => s.url)).toEqual([`wss://devnet.helius-rpc.com/?api-key=${KEY}`]);
    expect(w.jupiterCalls()).toEqual([]);
  });

  it('on mainnet the same fleet does reach Jupiter (the block is the network, not the mock)', async () => {
    const w = world();
    await fleet(w.h);
    const report = (await w.h.handle({ type: 'testConnections' })) as ConnectionReport;
    expect(report.network).toBe('mainnet');
    expect(report.jupiter?.ok).toBe(true);
    expect(w.jupiterCalls()).toHaveLength(1);
    expect(w.sockets.map((s) => s.url)).toEqual([`wss://mainnet.helius-rpc.com/?api-key=${KEY}`]);

    await refresh(w.h);
    const before = w.jupiterCalls().length;
    // DRY-RUN buy: the real Jupiter client asks for /order through the mock fetch.
    expect(await codeOf(w.h.handle({ type: 'startBuy', mint: MINT, wallets: all(w.h) }))).toBe(
      'ok',
    );
    await vi.waitFor(() => {
      expect(w.jupiterCalls().length).toBeGreaterThan(before);
    });
    await w.h.handle({ type: 'stop' });
    await vi.waitFor(async () => {
      expect((await status(w.h)).buy).toBeNull();
    });
  });
});
