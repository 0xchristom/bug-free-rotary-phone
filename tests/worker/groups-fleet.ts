/** Shared fleet setup of groups.test.ts and groups-limits.test.ts (split in BUNNDLY-74). */
import type { RpcTransport } from '@solana/kit';
import {
  AppError,
  defaultFleetSettings,
  type FleetSettingsV1,
  type WalletGroupV1,
} from '../../src/core/index.ts';
import type { JupiterClient } from '../../src/jupiter/index.ts';
import type { VaultFileResult, VaultStatus, WorkerEvent } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { FakeJupiter } from '../helpers/fake-jupiter.ts';
import { FakeSocket } from '../helpers/fake-socket.ts';
import { launch, signatureOf } from '../helpers/launch-fixtures.ts';
import { MINT_ACCOUNT } from '../helpers/mint-account.ts';
import { USDC, buildTransaction } from '../helpers/tx-fakes.ts';

export const PASSWORD = 'correct horse battery staple';
export const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
export const HELIUS_KEY = 'heliusGroupsKey';
export const N = launch(0);
export const CREATOR = N.watched;
export const MINT = N.expectedMint; // what B's watcher detects
export const RPC_DELAY_MS = 1_000;
/** Every /order but the probe waits this long: the runs stay running for the test. */
export const HOLD_MS = 600_000;
/** Enough for the shared order limiter (60 a minute by default) to let 8 orders out. */
export const SPREAD_MS = 10_000;

export const A: WalletGroupV1 = { id: 'g1', name: 'Snipers', wallets: [0, 1, 2] };
export const B: WalletGroupV1 = { id: 'g2', name: 'Rest', wallets: [3, 4, 5, 6, 7] };

export function bigints(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(bigints);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bigints(v)]));
  }
  return value;
}

export async function setup(
  holdMs = HOLD_MS,
  fleet: { readonly count: number; readonly groups: readonly WalletGroupV1[] } = {
    count: 8,
    groups: [A, B],
  },
) {
  const clock = new FakeClock();
  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case 'getMultipleAccounts':
        return {
          context: { slot: 1 },
          // the mints the tests buy are token mints to the target check (BUNNDLY-59)
          value: (params[0] as string[]).map((address) =>
            address === USDC || address === MINT
              ? MINT_ACCOUNT
              : {
                  lamports: 1_000_000_000,
                  owner: '11111111111111111111111111111111',
                  data: ['', 'base64'],
                  executable: false,
                  rentEpoch: 0,
                  space: 0,
                },
          ),
        };
      case 'getSignaturesForAddress':
        return [];
      case 'getTransaction':
        return params[0] === signatureOf(N) ? N.tx : null;
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const transport = (async (config: { payload: unknown }) => {
    const payload = config.payload as { id: unknown; method: string; params: unknown[] };
    await clock.sleep(RPC_DELAY_MS);
    return {
      jsonrpc: '2.0',
      id: payload.id,
      result: bigints(answer(payload.method, payload.params)),
    };
  }) as unknown as RpcTransport;
  const sockets: FakeSocket[] = [];
  /** Addresses of wallets 0 and 3, the first of A and of B: the probes. */
  const probes = new Set<string>();
  const fake = new FakeJupiter(clock, {
    transaction: (taker) => buildTransaction({ feePayer: taker }),
    orderDelayMs: ({ taker }) => (probes.has(taker) ? 100 : holdMs),
  });
  /** Every /order as it is called: the mint, the taker and the lamports asked. */
  const orders: { mint: string; taker: string; amount: bigint }[] = [];
  const jupiter: JupiterClient = {
    getOrder: (request) => {
      orders.push({ mint: request.outputMint, taker: request.taker ?? '', amount: request.amount });
      return fake.getOrder(request);
    },
    execute: (request) => fake.execute(request),
  };
  const h = createVaultHandler({
    chain: { createTransport: () => transport, sleep: () => Promise.resolve() },
    net: {
      createWebSocket: () => {
        const s = new FakeSocket(clock.now());
        sockets.push(s);
        return s;
      },
    },
    executor: { jupiter, clock },
    watch: { perfNow: () => clock.now() },
    now: () => clock.now(),
    autoLockMs: 60_000,
  });
  const events: WorkerEvent[] = [];
  h.onEvent((e) => events.push(e));
  await h.handle({
    type: 'create',
    fleetName: 'Grupy',
    walletCount: fleet.count,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const base = defaultFleetSettings();
  const settings = (groups: readonly WalletGroupV1[]): FleetSettingsV1 => ({
    ...base,
    maxSpend: Array.from({ length: fleet.count }, (_, index) => ({
      index,
      lamports: 10_000_000n,
    })),
    global: { ...base.global, mode: 'continuous' },
    groups,
  });
  const save = (groups: readonly WalletGroupV1[]) =>
    h.handle({
      type: 'saveSettings',
      settings: settings(groups),
      apiKeys: { helius: HELIUS_KEY },
    }) as Promise<VaultFileResult>;
  const saved = await save(fleet.groups);
  /** Saves the settings from the start with `change` applied, the groups as they are now. */
  const saveWith = (
    change: (s: FleetSettingsV1) => FleetSettingsV1,
    apiKeys: Record<string, string | null> = {},
  ) => h.handle({ type: 'saveSettings', settings: change(settings(fleet.groups)), apiKeys });
  const status = async () => (await h.handle({ type: 'status' })) as VaultStatus;
  const addresses = ((await status()).info?.wallets ?? []).map((w) => w.address);
  for (const i of [0, 3]) probes.add(addresses[i] ?? '');
  /** Wallet indices that asked /order for `mint`, ascending. */
  const askedBy = (mint: string): number[] =>
    orders
      .filter((o) => o.mint === mint)
      .map((o) => addresses.indexOf(o.taker))
      .sort((a, b) => a - b);
  const group = async (id: string) => (await status()).groups.find((g) => g.id === id);
  /** The balance read takes the RPC's 1 s of fake time. */
  const withRpc = async <T>(p: Promise<T>): Promise<T> => {
    await clock.runUntil(clock.now() + RPC_DELAY_MS);
    const result = await p;
    await clock.settle();
    return result;
  };
  // The worker checks each mint once per session (BUNNDLY-59): here, before the buys, so
  // a buy below costs no extra RPC time.
  await withRpc(h.handle({ type: 'classifyTarget', address: USDC }));
  await withRpc(h.handle({ type: 'classifyTarget', address: MINT }));
  const startBuy = async (id: string, mint = USDC) => {
    await withRpc(h.handle({ type: 'refreshBalances' }));
    await h.handle({ type: 'startBuy', group: id, mint });
    await clock.runUntil(clock.now() + SPREAD_MS);
  };
  const arm = async (id: string) => {
    // two reads: what the creator address is (BUNNDLY-59), then the balances
    const armed = h.handle({ type: 'arm', group: id, creator: CREATOR });
    await clock.runUntil(clock.now() + 2 * RPC_DELAY_MS);
    await armed;
    await clock.settle();
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket');
    socket.connect();
    await clock.settle();
    return socket;
  };
  /** Lets every held /order answer and every run end. */
  const untilIdle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await clock.runUntil(clock.now() + holdMs);
      if ((await status()).groups.every((g) => g.buy === null)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('a run did not finish');
  };
  return {
    clock,
    h,
    addresses,
    events,
    orders,
    status,
    group,
    save,
    saveWith,
    saved,
    askedBy,
    startBuy,
    arm,
    untilIdle,
  };
}

export async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AppError ? e.code : 'other'),
  );
}
